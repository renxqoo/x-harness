// gateway 入口与命令管线（DESIGN §1.2.1/§3.2）：装配 identity/config/host-attach/
// threads-registry/owner-server/fanout/audit；owner gw/* 命令族路由 + host 命令
// scope 执法 + id 重映射 + 去重日志 + response 认领回投 + host 死亡结算。
import { readFile } from "node:fs/promises";
import { derivePaths, loadConfig } from "./config.ts";
import { loadOrCreateIdentity, type GatewayIdentity } from "./identity.ts";
import { HostAttach, resolveHostBin } from "./host-attach.ts";
import { loadThreads, type ThreadsRegistry } from "./threads-registry.ts";
import { loadDeviceRegistry, type DeviceRegistry } from "./device-registry.ts";
import { startOwnerServer, type OwnerServerHandle, type OwnerSession } from "./owner-server.ts";
import { Fanout, type ClientTarget } from "./fanout.ts";
import { createHostIngest } from "./host-ingest.ts";
import { openAuditLog, type AuditLog } from "./audit.ts";
import { createHash } from "node:crypto";

const OUTBOUND_PAYLOAD_MAX = 12 * 1024 * 1024; // 密文+base64 后上限（DESIGN §3.5）
import { PAIRING_MAX_CONCURRENT, aeadSeal, buildAad, decodeEnvelope, encodeEnvelope, judgeGwCommand, judgeHostCommand, parseFrame, parseNonce, type Frame } from "@x-harness/remote-protocol";
import { createPairingServer } from "./pairing-server.ts";
import { newBucket, processInboundLine, type RateBucket } from "./inbound.ts";
import { startRelayLink, type RelayLinkHandle } from "./relay-link.ts";
import { createCryptoSessionPool, type CryptoSessionPool } from "./session-crypto.ts";

export interface GatewayOptions {
  agentDir: string;
  now?(): number;
  log?(message: string): void;
  hostOverride?: { command: string; args: string[] };
}

export interface GatewayHandle {
  identity: GatewayIdentity;
  threads: ThreadsRegistry;
  devices: DeviceRegistry;
  fanout: Fanout;
  audit: AuditLog;
  ownerServer: OwnerServerHandle;
  host: HostAttach;
  cryptoSessions: CryptoSessionPool;
  pairingServer: ReturnType<typeof createPairingServer>;
  relayLink: RelayLinkHandle | null;
  stop(): Promise<void>;
  /** 测试面：直接注入 owner 帧 */
  handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void>;
  /** 测试面：注入设备帧（经完整入站管线） */
  ingestDeviceLine(deviceId: string, line: string): Promise<void>;
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => process.stderr.write(`gw: ${message}\n`));
  let rawConfig: string | null = null;
  try {
    rawConfig = await readFile(`${options.agentDir}/gateway.json`, "utf8");
  } catch {
    rawConfig = null;
  }
  const configResult = loadConfig(rawConfig);
  if (!configResult.ok) throw new Error(configResult.reason);
  const config = configResult.config;
  const paths = derivePaths(options.agentDir, config);
  const identity = await loadOrCreateIdentity(paths);
  const threads = await loadThreads(paths.threadsFile);
  const devices = await loadDeviceRegistry(paths);
  const audit = await openAuditLog(paths.auditDir, now);
  const logLines: string[] = [];
  const logBuffer = {
    push(line: string): void {
      logLines.push(line);
      if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
    },
    tail(): string[] {
      return [...logLines];
    },
  };
  const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now });
  // scope 变更即时生效（D4）：tier 恒从注册表现值裁决
  fanout.setTierResolver((target) => {
    if (target === "owner") return "owner";
    return devices.get(target)?.scope ?? "read";
  });
  await audit.record("gateway-started", { installationId: identity.installationId, remoteEnabled: config.remoteEnabled });

  // ---- host 附着（单写者） ----
  const exec = options.hostOverride ?? resolveHostBin(config.hostBin);
  const pendingByHostId = new Map<string, { deviceId: string; commandId: string; command: string; ownerSession?: OwnerSession }>();
  // B4：崩溃重启后按去重日志重建在飞映射
  for (const pending of devices.pendingHostIds()) {
    pendingByHostId.set(pending.hostId, { deviceId: pending.deviceId, commandId: pending.commandId, command: "unknown" });
  }
  const host = new HostAttach({
    exec,
    env: { ...process.env, HUB_AGENT_DIR: options.agentDir } as Record<string, string>,
    heartbeatDeadlineMs: 10_000,
    onLine: (line) => ingestHostLine(line),
    onRestart: (reason) => {
      void audit.record("host-restarted", { reason });
      // host 死亡结算：pending 合成恰一 failure（§1.2.1 M10）
      for (const [hostId, pending] of pendingByHostId) {
        void devices.appendResponse(pending.deviceId, pending.commandId, { id: pending.commandId, command: pending.command, success: false, error: "host unavailable" });
        pendingByHostId.delete(hostId);
      }
    },
    log,
  });

  const hostIngest = createHostIngest({
    fanout,
    devices,
    threads,
    audit,
    pendingByHostId,
    sendToDevice: (deviceId, frame) => {
      void sendToDevice(deviceId, frame);
    },
    replyOwner: (pending, body) => {
      const session = pending.ownerSession as OwnerSession | undefined;
      if (session !== undefined && !session.closed) {
        session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body });
      }
    },
  });
  const ingestHostLine = hostIngest.ingest;
  const seqCounters = new Map<string, number>();

  function nextSeqFor(streamId: string): number {
    const next = (seqCounters.get(streamId) ?? 0) + 1;
    seqCounters.set(streamId, next);
    return next;
  }

  host.start();
  const cryptoSessions = createCryptoSessionPool(paths.devicesDir, now);
  const pairingServer = createPairingServer({
    identity,
    relayUrl: config.relayUrl,
    relayKeyFingerprint: config.relayKeyFingerprint,
    audit,
    now,
    requestPairingTicket: async () => `ticket_local_${Date.now()}`,
    onRegistered: async (device) => {
      devices.put({
        deviceId: device.deviceId,
        name: device.name,
        deviceType: device.deviceType,
        platform: device.platform,
        appVersion: device.appVersion,
        longTermPub: device.longTermPub,
        scope: device.scope,
        pairedAt: now(),
        lastSeenAt: now(),
        rekeyCounter: 0,
      });
    },
    maxConcurrent: PAIRING_MAX_CONCURRENT,
  });
  const deviceBuckets = new Map<string, RateBucket>();
  const deviceIngestChains = new Map<string, Promise<void>>(); // per-device 串行化解密

  /** 设备帧出站：ratchet seal → L3 信封 → relay-link（未连时丢弃+计数） */
  async function sendToDevice(deviceId: string, frame: Frame): Promise<void> {
    const run = (deviceIngestChains.get(deviceId) ?? Promise.resolve()).then(() => sendToDeviceInner(deviceId, frame));
    deviceIngestChains.set(deviceId, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }

  const devicePending = new Map<string, Frame[]>();
  const DEVICE_PENDING_MAX = 256;

  /** link 断线窗口的设备帧重发（§1.2 outbox——有界，满则丢最旧） */
  function flushDevicePending(): void {
    const link = relayLinkRef;
    if (link === null || !link.connected()) return;
    for (const [deviceId, frames] of devicePending) {
      for (const frame of frames) void sendToDevice(deviceId, frame);
      devicePending.set(deviceId, []);
    }
  }

  async function sendToDeviceInner(deviceId: string, frame: Frame): Promise<void> {
    const session = cryptoSessions.get(deviceId) ?? (await cryptoSessions.restore(deviceId));
    const link = relayLinkRef;
    if (session === null) return;
    if (link === null || !link.connected()) {
      const queue = devicePending.get(deviceId) ?? [];
      queue.push(frame);
      if (queue.length > DEVICE_PENDING_MAX) queue.splice(0, queue.length - DEVICE_PENDING_MAX);
      devicePending.set(deviceId, queue);
      return;
    }
    const outcome = await session.ratchet.seal({ plaintext: new TextEncoder().encode(JSON.stringify(frame)), aadFrom: `gw_${identity.installationId}`, aadTo: `dev_${deviceId}` });
    if (!outcome.ok) return;
    const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
    const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(JSON.stringify(frame)), aad: outcome.aad });
    const payload = Buffer.from(ct).toString("base64");
    // E4：超限帧不进链路（chunk 重组是显式边界，DESIGN §6）
    if (payload.length > OUTBOUND_PAYLOAD_MAX) {
      log(`outbound frame exceeds cap (${payload.length}B) — dropped`);
      return;
    }
    const env = encodeEnvelope({ v: 1, from: `gw_${identity.installationId}`, to: `dev_${deviceId}`, payload, nonce: Buffer.from(outcome.nonce).toString("base64") });
    link.send(env);
  }

  /** 设备入站线（relay onFrame → 此处；预解密后走管线执法） */
  function ingestDeviceLine(deviceId: string, line: string): Promise<void> {
    // per-device 串行化：ratchet 接收游标顺序推进（并发解密会错位）
    const run = (deviceIngestChains.get(deviceId) ?? Promise.resolve()).then(() => ingestDeviceLineInner(deviceId, line));
    deviceIngestChains.set(deviceId, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }

  async function ingestDeviceLineInner(deviceId: string, line: string): Promise<void> {
    const entry = devices.get(deviceId);
    if (entry === null) return;
    const session = cryptoSessions.get(deviceId) ?? (await cryptoSessions.restore(deviceId));
    if (session === null) return;
    const env = decodeEnvelope(line);
    if (env === null) return;
    // index/epoch 从信封 nonce 反解（WIRE §4 布局）——密文自带序，重复/乱序经 ratchet 三态
    const ct = new Uint8Array(Buffer.from(env.payload, "base64"));
    const nonceBytes = new Uint8Array(Buffer.from(env.nonce, "base64"));
    const parsed = parseNonce(nonceBytes);
    if (parsed === null) return;
    const outcome = await session.ratchet.open({
      ciphertext: ct,
      nonce: nonceBytes,
      aad: buildAad(`dev_${deviceId}`, `gw_${identity.installationId}`, parsed.epoch),
      index: parsed.index,
      epoch: parsed.epoch,
    });
    if (!outcome.ok) return;
    const plaintext = Buffer.from(outcome.plaintext).toString("utf8");
    if (fanout.targetOf(deviceId) === null) {
      fanout.attach({
        target: deviceId,
        tier: entry.scope,
        subscribedThreads: new Set(),
        send: (frame) => {
          void sendToDevice(deviceId, frame);
        },
      });
    }
    const bucket = deviceBuckets.get(deviceId) ?? newBucket();
    deviceBuckets.set(deviceId, bucket);
    processInboundLine(line, {
      deviceId,
      tier: entry.scope,
      bucket,
      decrypt: () => ({ plaintext, tagFailures: 0 }),
      onCommand(frame, command, args) {
        const body = frame.body as { id?: string };
        const commandId = typeof body.id === "string" ? body.id : `auto_${frame.seq}`;
        // 提交并入 per-device 串行链（B5a——保序 FIFO）
        const run = (deviceIngestChains.get(deviceId) ?? Promise.resolve()).then(() =>
          submitCommand({
            deviceId,
            commandId,
            command,
            args,
            reply: {
              send(frameBody) {
                void sendToDevice(deviceId, { kind: "response", streamId: `cmd:${deviceId}`, seq: nextSeqFor(`cmd:${deviceId}`), body: frameBody });
              },
            },
          }),
        );
        deviceIngestChains.set(deviceId, run.then(
          () => undefined,
          () => undefined,
        ));
      },
      onUiResponse(requestId, payload) {
        host.write(JSON.stringify({ type: "ui_response", requestId, payload }));
        void audit.record("ui_request-settled", { requestId, deviceId, decision: JSON.stringify(payload) });
      },
      onAck(streamId, upTo) {
        fanout.applyAckFor(deviceId, streamId, upTo);
      },
      now,
    });
  }

  let relayLinkRef: RelayLinkHandle | null = null;
  if (config.remoteEnabled) {
    relayLinkRef = startRelayLink({
      relayUrl: config.relayUrl,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: config.relayUrl.startsWith("wss://"),
      onFrame: (line) => {
        // 坏行不得崩守护进程（C8——入口守卫）
        try {
          const parsed = JSON.parse(line) as { from?: string };
          if (typeof parsed.from === "string" && parsed.from.startsWith("dev_")) {
            void ingestDeviceLine(parsed.from.slice(4), line);
          }
        } catch {
          log(`relay frame unparseable (len=${line.length})`);
        }
      },
      onStatus: (status, detail) => {
        log(`relay ${status}: ${detail}`);
        if (status === "connected") flushDevicePending();
        fanout.fanoutEvent({ threadId: "*", name: "gateway/presence", payload: { relay: status, detail } });
      },
      log,
    });
    void relayLinkRef.enrollOnce().then((enrolled) => {
      if (enrolled === null) log("relay enroll failed (will retry via reconnect)");
    });
  }

  // ---- owner 通道 ----
  const ownerTarget: ClientTarget & { session: OwnerSession | null } = {
    target: "owner",
    tier: "owner",
    subscribedThreads: new Set(),
    session: null,
    send(frame) {
      ownerTarget.session?.send(frame);
    },
  };
  const ownerServer = await startOwnerServer({
    socketPath: paths.ownerSocket,
    pidFile: paths.gatewayPidFile,
    log,
    onConnect(session) {
      ownerTarget.session = session;
      fanout.attach(ownerTarget);
    },
    onClose(session) {
      // 只清当前会话（旧连接的迟到 close 不抹新会话——竞态修复）
      if (ownerTarget.session === session) ownerTarget.session = null;
    },
    onFrame: (session, frame) => {
      void handleOwnerFrame(session, frame);
    },
  });

  async function handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void> {
    if (frame.kind !== "command") {
      if (frame.kind === "ui_response") {
        // owner 应答弹窗（先答先得）
        const body = frame.body as { requestId?: string; payload?: Record<string, unknown> };
        if (typeof body.requestId === "string") {
          host.write(JSON.stringify({ type: "ui_response", requestId: body.requestId, payload: body.payload ?? {} }));
          await audit.record("ui_request-settled", { requestId: body.requestId, deviceId: "owner", decision: JSON.stringify(body.payload ?? {}) });
        }
      }
      return;
    }
    const body = frame.body as { command?: string; id?: string; args?: Record<string, unknown> };
    const command = body.command;
    const id = body.id;
    if (typeof command !== "string" || typeof id !== "string") {
      session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: { id: "?", command: "?", success: false, error: "invalid command frame" } });
      return;
    }
    // gw/* 本地命令族
    if (judgeGwCommand(command, "owner") !== "unknown-command") {
      const result = await handleGwCommand(command, body.args ?? {});
      session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: { id, command, success: result.ok, ...(result.ok ? { data: result.data } : { error: result.reason }) } });
      return;
    }
    if (judgeGwCommand(command, "owner") === "unknown-command" && command.startsWith("gw/")) {
      await audit.record("owner-only-denied", { deviceId: "owner", command });
      session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: { id, command, success: false, error: "unknown gw command" } });
      return;
    }
    // host 命令（owner 全权）——与设备共用同一条提交管线
    // reply 绑定提交会话（C7：旧连接的 response 不投新连接）
    await submitCommand({
      deviceId: "owner",
      commandId: id,
      command,
      args: body.args ?? {},
      ownerSession: session,
      reply: {
        send(frameBody) {
          if (!session.closed) session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: frameBody });
        },
      },
    });
  }

  interface Reply {
    send(body: unknown): void;
  }

  async function submitCommand(spec: { deviceId: string; commandId: string; command: string; args: Record<string, unknown>; reply: Reply; ownerSession?: OwnerSession }): Promise<void> {
    const { deviceId, commandId, command, args, reply, ownerSession } = spec;
    // scope 执法（owner 全权）
    // owner 对 host 命令面也走矩阵（矩阵外/未知命令拒——S2 fail-closed 对 owner 同样成立）
    const verdict = deviceId === "owner" ? judgeHostCommand(command, "owner") : judgeHostCommand(command, tierOf(deviceId));
    if (verdict !== "allow") {
      if (verdict === "owner-only") {
        await audit.record("owner-only-denied", { deviceId, command });
        reply.send({ id: commandId, command, success: false, error: "owner-only" });
        return;
      }
      if (verdict === "scope-denied") {
        await audit.record("scope-denied", { deviceId, command });
        reply.send({ id: commandId, command, success: false, error: "scope-denied" });
        return;
      }
      reply.send({ id: commandId, command, success: false, error: "unknown-command" });
      return;
    }
    // 去重（write-ahead 崩溃安全）
    const dedup = devices.dedupLookup(deviceId, commandId);
    if (dedup !== null) {
      if (dedup.response !== undefined) reply.send(dedup.response);
      else reply.send({ id: commandId, command, success: false, error: "command-expired" });
      return;
    }
    const hostId = fanout.mintHostId();
    const bodyHash = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
    await devices.appendCommand(deviceId, { commandId, hostId, bodyHash, ts: now() });
    devices.mapHostId(hostId, { deviceId, commandId });
    pendingByHostId.set(hostId, { deviceId, commandId, command, ...(ownerSession !== undefined ? { ownerSession } : {}) });
    // 命令订阅建立（thread 域命令）
    const threadId = typeof args.threadId === "string" ? args.threadId : null;
    const target = fanout.targetOf(deviceId);
    if (threadId !== null && target !== null) target.subscribedThreads.add(threadId);
    const line = JSON.stringify({ ...args, type: command, id: hostId });
    const written = host.write(line);
    if (!written) {
      // B5b：失败路径立即落 response 进去重缓存并清 pending
      const failure = { id: commandId, command, success: false, error: "host unavailable" };
      pendingByHostId.delete(hostId);
      void devices.appendResponse(deviceId, commandId, failure);
      reply.send(failure);
    }
  }

  function tierOf(deviceId: string): "read" | "interact" | "full" {
    return devices.get(deviceId)?.scope ?? "read";
  }

  type GwResult = { ok: true; data: unknown } | { ok: false; reason: string };

  async function handleGwCommand(command: string, args: Record<string, unknown>): Promise<GwResult> {
    if (command === "gw/status") {
      return { ok: true, data: { installationId: identity.installationId, remoteEnabled: config.remoteEnabled, devices: devices.list().length, threads: threads.all().length, hostAlive: host.alive() } };
    }
    if (command === "gw/devices/list") return { ok: true, data: devices.list() };
    if (command === "gw/devices/rename" || command === "gw/devices/set_scope" || command === "gw/devices/revoke") {
      return handleGwDeviceCommand(command, args);
    }
    if (command === "gw/config/get") return { ok: true, data: config };
    if (command === "gw/config/set") {
      // 热应用面：仅 remoteEnabled（其余键重启生效——如实返回）
      if (typeof args.remoteEnabled === "boolean") {
        config.remoteEnabled = args.remoteEnabled;
        await audit.record("config-changed", { remoteEnabled: args.remoteEnabled });
        return { ok: true, data: { ...config, restartRequired: ["relayUrl", "relayKeyFingerprint", "hostBin"] } };
      }
      return { ok: false, reason: "restart required for this key" };
    }
    if (command === "gw/logs/tail") return { ok: true, data: { lines: logBuffer.tail() } };
    if (command === "gw/shutdown") {
      setTimeout(() => {
        void handle.stop();
      }, 100);
      return { ok: true, data: { stopping: true } };
    }
    if (command === "gw/pairing/start" || command === "gw/pairing/cancel") {
      return handleGwPairing(command, args);
    }
    return { ok: false, reason: "unknown gw command" };
  }

  async function handleGwPairing(command: string, args: Record<string, unknown>): Promise<GwResult> {
    if (command === "gw/pairing/cancel") {
      const pairingId = args.pairingId;
      if (typeof pairingId !== "string") return { ok: false, reason: "pairingId required" };
      pairingServer.cancel(pairingId);
      return { ok: true, data: { cancelled: true } };
    }
    const scope = args.scope === "interact" || args.scope === "full" ? args.scope : "read";
    const mode = args.mode === "manual" ? "manual" : "qr";
    const started = mode === "manual" ? await pairingServer.startManual(scope) : await pairingServer.startQr(scope);
    return { ok: true, data: { pairingId: started.pairingId, qrPayload: "qrPayload" in started ? started.qrPayload : undefined, manualCode: "manualCode" in started ? started.manualCode : undefined, ticket: started.ticket } };
  }

  async function handleGwDeviceCommand(command: string, args: Record<string, unknown>): Promise<GwResult> {
    const deviceId = args.deviceId;
    if (typeof deviceId !== "string") return { ok: false, reason: "deviceId required" };
    const entry = devices.get(deviceId);
    if (entry === null) return { ok: false, reason: "no such device" };
    if (command === "gw/devices/rename") {
      if (typeof args.name === "string") entry.name = args.name;
      devices.put(entry);
      return { ok: true, data: entry };
    }
    if (command === "gw/devices/set_scope") {
      const scope = args.scope;
      if (scope !== "read" && scope !== "interact" && scope !== "full") return { ok: false, reason: "scope must be read|interact|full" };
      entry.scope = scope;
      devices.put(entry);
      await audit.record("device-scope-changed", { deviceId, scope });
      return { ok: true, data: entry };
    }
    const hit = devices.remove(deviceId);
    await audit.record("device-revoked", { deviceId });
    return hit ? { ok: true, data: { deviceId } } : { ok: false, reason: "no such device" };
  }

  const handle: GatewayHandle = {
    identity,
    threads,
    devices,
    fanout,
    audit,
    ownerServer,
    host,
    cryptoSessions,
    pairingServer,
    relayLink: relayLinkRef,
    handleOwnerFrame,
    ingestDeviceLine,
    async stop() {
      await audit.record("gateway-stopped", {});
      relayLinkRef?.stop();
      await ownerServer.close();
      await host.stop();
    },
  };
  return handle;
}

export { parseFrame };
