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
import { chunkFrame, aeadSeal, buildAad, decodeEnvelope, encodeEnvelope, judgeHostCommand, parseNonce, rekeyDue, startRekey, type Frame } from "@x-harness/remote-protocol";
import { assemblePairingServer } from "./pairing-assembly.ts";
import { createLogBuffer } from "./log-buffer.ts";
import { makeGwDispatcher } from "./gw-dispatch.ts";
import { makeOwnerDispatcher } from "./owner-dispatch.ts";
import { newBucket, processInboundLine, type RateBucket } from "./inbound.ts";
import { startRelayLink, type RelayLinkHandle } from "./relay-link.ts";
import { createCryptoSessionPool, type CryptoSessionPool } from "./session-crypto.ts";
export interface GatewayOptions {
  agentDir: string;
  now?(): number;
  log?(message: string): void;
  hostOverride?: { command: string; args: string[]; env?: Record<string, string> };
  /** rekey sweep 间隔（缺省 60s；测试注入缩短） */
  rekeySweepMs?: number;
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
  pairingServer: import("./pairing-server.ts").PairingServer;
  relayLink: RelayLinkHandle | null;
  stop(): Promise<void>;
  /** 测试面：直接注入 owner 帧 */
  handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void>;
  /** 测试面：注入设备帧（经完整入站管线） */
  ingestDeviceLine(deviceId: string, line: string): Promise<void>;
}
export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const now = options.now ?? Date.now;
  let handleRef: GatewayHandle | null = null;
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
  const logBuffer = createLogBuffer();
  // 日志双写：注入 log 进缓冲（gw/logs/tail 读到真实内容）+ stderr 缺省
  const userLog = options.log;
  const stderrSink = (message: string): void => {
    process.stderr.write(`gw: ${message}\n`);
  };
  const bufferedLog = (message: string): void => {
    logBuffer.push(message);
    (userLog ?? stderrSink)(message);
  };
  const log = bufferedLog;
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
  const pairingServer = assemblePairingServer({ identity, config, audit, devices, now, relayLink: () => relayLinkRef, cryptoSessions });

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

  /** 配对面路由（E1 收口：手机经 relay /pairing 连接的帧——明文 JSON 信封，配对通道密钥层在协议包） */
  async function ingestPairingFrame(pairingId: string, line: string): Promise<void> {
    const session = pairingServer.sessionOf(pairingId);
    if (session === null) {
      log(`pairing frame for unknown session ${pairingId}`);
      return;
    }
    const env = decodeEnvelope(line);
    if (env === null) return;
    let message: { p: string; [key: string]: unknown };
    try {
      message = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as { p: string; [key: string]: unknown };
    } catch {
      return;
    }
    const result = await pairingServer.handlePairingFrame({ pairingId, message });
    const replyEnvelope = result.ok
      ? encodeEnvelope({ v: 1, from: `gw_${identity.installationId}`, to: `pairing_${pairingId}`, payload: Buffer.from(JSON.stringify(result.reply)).toString("base64"), nonce: Buffer.alloc(17).toString("base64") })
      : encodeEnvelope({ v: 1, from: `gw_${identity.installationId}`, to: `pairing_${pairingId}`, payload: Buffer.from(JSON.stringify({ p: "rejected", reason: result.reason })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") });
    relayLinkRef?.send(replyEnvelope);
  }

  /** rekey 旅程：发起（签名）→ 设备 accept → 双端换链（epoch++）。本轮实现发起侧落盘 + 通知帧 */
  async function performRekey(deviceId: string, oldRootKey: string, nextCounter: number): Promise<void> {
    const started = startRekey({ initiatorSigningSecret: identity.signingSecret, initiatorSigningPub: identity.signingPub, peerCurrentRatchetPub: "", rekeyCounter: nextCounter });
    const frame: Frame = { kind: "rekey", streamId: `rekey:${deviceId}`, seq: nextSeqFor(`rekey:${deviceId}`), body: started.request };
    void sendToDevice(deviceId, frame);
    void oldRootKey;
    const entry = devices.get(deviceId);
    if (entry !== null) {
      entry.rekeyCounter = nextCounter;
      devices.put(entry);
    }
    await audit.record("rekey-performed", { deviceId, rekeyCounter: nextCounter });
  }

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
    // 大帧 chunk 化（§1.2/§3.5）：切片多信封发送，接收端按 (streamId,seq) 重组。
    // 段阈值内走单帧直发。
    const segs = chunkFrame(frame);
    if (segs === null) {
      await sendSealed({ deviceId, link, ratchet: session.ratchet, frame });
      return;
    }
    for (const seg of segs) {
      const segFrame: Frame = { kind: "chunk", streamId: seg.streamId, seq: seg.seq, body: { segmentId: seg.segmentId, segmentCount: seg.segmentCount, totalBytes: 0, data: seg.data } };
      await sendSealed({ deviceId, link, ratchet: session.ratchet, frame: segFrame });
    }
  }
  interface SealedSendSpec {
    deviceId: string;
    link: RelayLinkHandle;
    ratchet: import("./session-crypto.ts").DeviceCryptoSession["ratchet"];
    frame: Frame;
  }
  async function sendSealed(spec: SealedSendSpec): Promise<void> {
    const { deviceId, link, ratchet, frame } = spec;
    const outcome = await ratchet.seal({ plaintext: new TextEncoder().encode(JSON.stringify(frame)), aadFrom: `gw_${identity.installationId}`, aadTo: `dev_${deviceId}` });
    if (!outcome.ok) return;
    const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
    const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(JSON.stringify(frame)), aad: outcome.aad });
    const payload = Buffer.from(ct).toString("base64");
    if (payload.length > OUTBOUND_PAYLOAD_MAX) {
      log(`outbound segment exceeds cap (${payload.length}B) — dropped`);
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
  // 强制 rekey 调度（S4：暴露窗 ≤2000 帧/24h）
  const rekeyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleRekeyCheck(): void {
    const timer = setInterval(() => {
      for (const device of devices.list()) {
        const session = cryptoSessions.get(device.deviceId);
        if (session === null) continue;
        if (rekeyDue(session.ratchet.messagesSinceDhCount(), session.establishedAt, now())) {
          void performRekey(device.deviceId, session.ratchet.snapshotSend().rootKey, device.rekeyCounter + 1);
        }
      }
    }, options.rekeySweepMs ?? 60_000);
    rekeyTimers.set("__sweep__", timer);
  }
  if (config.remoteEnabled) {
    relayLinkRef = startRelayLink({
      relayUrl: config.relayUrl,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: config.relayUrl.startsWith("wss://"),
      expectedRelayFingerprint: config.relayUrl.startsWith("wss://") ? config.relayKeyFingerprint : "",
      onFrame: (line) => {
        // 坏行不得崩守护进程（C8——入口守卫）
        try {
          const parsed = JSON.parse(line) as { from?: string };
          if (typeof parsed.from !== "string") return;
          if (parsed.from.startsWith("pairing_")) {
            void ingestPairingFrame(parsed.from.slice("pairing_".length), line);
            return;
          }
          if (parsed.from.startsWith("dev_")) {
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
  interface Reply {
    send(body: unknown): void;
  }
  async function submitCommand(spec: { deviceId: string; commandId: string; command: string; args: Record<string, unknown>; reply: Reply; ownerSession?: OwnerSession }): Promise<void> {
    const { deviceId, commandId, command, args, reply, ownerSession } = spec;
    // scope 执法：owner 对 host 命令面也走矩阵（矩阵外/未知拒——S2 fail-closed 不豁免）
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

  scheduleRekeyCheck();
  const handleGwCommand = makeGwDispatcher({
    identity,
    onPairingConfirmed: async (deviceId, ratchetSeed) => {
      cryptoSessions.establish({ deviceId, sharedSecret: ratchetSeed, initiator: true });
    },
    relayLink: () => relayLinkRef,
    config,
    audit,
    devices,
    threads,
    host,
    pairingServer,
    cryptoSessions,
    fanout,
    deviceBuckets,
    deviceIngestChains,
    devicePending,
    stopGateway: () => {
      void Promise.resolve(handleRef).then((h) => h?.stop());
    },
    logBuffer,
  });
  const handleOwnerFrame = makeOwnerDispatcher({
    hostWrite: (line) => host.write(line),
    auditRecord: (event: import("./audit.ts").AuditEvent, detail: Record<string, unknown>) => audit.record(event, detail),
    handleGwCommand,
    nextOwnerSeq: () => nextSeqFor("owner"),
    submitOwnerCommand: async ({ session, commandId, command, args }) => {
      await submitCommand({
        deviceId: "owner",
        commandId,
        command,
        args,
        ownerSession: session,
        reply: {
          send(frameBody) {
            if (!session.closed) session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: frameBody });
          },
        },
      });
    },
  });
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
      for (const timer of rekeyTimers.values()) clearInterval(timer);
      rekeyTimers.clear();
      relayLinkRef?.stop();
      await ownerServer.close();
      await host.stop();
    },
  };
  handleRef = handle;
  return handle;
}
