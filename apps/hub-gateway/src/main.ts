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
import { classifyHostLine, Fanout, type ClientTarget } from "./fanout.ts";
import { openAuditLog, type AuditLog } from "./audit.ts";
import { createHash } from "node:crypto";
import { judgeGwCommand, judgeHostCommand, parseFrame, type Frame } from "@x-harness/remote-protocol";

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
  stop(): Promise<void>;
  /** 测试面：直接注入 owner 帧 */
  handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void>;
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
  const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now });
  await audit.record("gateway-started", { installationId: identity.installationId, remoteEnabled: config.remoteEnabled });

  // ---- host 附着（单写者） ----
  const exec = options.hostOverride ?? resolveHostBin(config.hostBin);
  const pendingByHostId = new Map<string, { deviceId: string; commandId: string; command: string }>();
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

  function ingestHostLine(line: string): void {
    const kind = classifyHostLine(line);
    if (kind === "heartbeat" || kind === "hub_error" || kind === "unknown") return;
    if (kind === "response") {
      ingestResponse(line);
      return;
    }
    if (kind === "event" || kind === "ui_request") {
      ingestEventOrUi(kind, line);
      return;
    }
    ingestLifecycle(kind, line);
  }

  function parseLine<T>(line: string): T | null {
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }

  function ingestResponse(line: string): void {
    const parsed = parseLine<{ id?: unknown; command?: unknown; success?: unknown; data?: unknown; error?: unknown }>(line);
    if (parsed === null) return;
    const hostId = typeof parsed.id === "string" ? parsed.id : null;
    if (hostId === null) return;
    const pending = pendingByHostId.get(hostId);
    pendingByHostId.delete(hostId);
    if (pending === undefined) return; // 无人认领：丢弃+计数（发起者断线）
    const responseBody = { id: pending.commandId, command: pending.command, success: parsed.success === true, data: parsed.data, error: typeof parsed.error === "string" ? parsed.error : undefined };
    void devices.appendResponse(pending.deviceId, pending.commandId, responseBody);
    adoptThreadFromResponse(parsed.data, pending.deviceId);
    const target = fanout.targetOf(pending.deviceId);
    target?.send({ kind: "response", streamId: `cmd:${pending.deviceId}`, seq: nextSeqFor(`cmd:${pending.deviceId}`), body: responseBody });
    void audit.record("command-issued", { deviceId: pending.deviceId, command: pending.command, ok: responseBody.success });
  }

  /** thread/start|resume|register|fork|clone 的 response data 携带 threadId——认领时建订阅+登记注册表 */
  function adoptThreadFromResponse(data: unknown, deviceId: string): void {
    if (typeof data !== "object" || data === null) return;
    const record = data as Record<string, unknown>;
    if (typeof record.threadId !== "string") return;
    const target = fanout.targetOf(deviceId);
    target?.subscribedThreads.add(record.threadId);
    if (typeof record.sessionPath === "string") threads.upsert({ threadId: record.threadId, sessionPath: record.sessionPath });
  }

  function ingestEventOrUi(kind: "event" | "ui_request", line: string): void {
    const parsed = parseLine<{ threadId?: unknown; name?: unknown; payload?: unknown; requestId?: unknown; method?: unknown }>(line);
    if (parsed === null) return;
    if (kind === "event") {
      if (typeof parsed.threadId === "string" && typeof parsed.name === "string") {
        fanout.fanoutEvent({ threadId: parsed.threadId, name: parsed.name, payload: parsed.payload });
      }
      return;
    }
    if (typeof parsed.requestId === "string" && typeof parsed.threadId === "string" && typeof parsed.method === "string") {
      fanout.fanoutUiRequest({ requestId: parsed.requestId, threadId: parsed.threadId, method: parsed.method, payload: (parsed.payload as Record<string, unknown>) ?? {} });
    }
  }

  function ingestLifecycle(kind: "thread_died" | "thread_parked", line: string): void {
    const parsed = parseLine<{ threadId?: unknown }>(line);
    if (parsed === null) return;
    if (typeof parsed.threadId === "string") fanout.fanoutEvent({ threadId: parsed.threadId, name: kind, payload: parsed });
  }

  const seqCounters = new Map<string, number>();
  function nextSeqFor(streamId: string): number {
    const next = (seqCounters.get(streamId) ?? 0) + 1;
    seqCounters.set(streamId, next);
    return next;
  }

  host.start();

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
    await submitCommand({ deviceId: "owner", commandId: id, command, args: body.args ?? {}, reply: { send(frameBody) { session.send({ kind: "response", streamId: "owner", seq: nextSeqFor("owner"), body: frameBody }); } } });
  }

  interface Reply {
    send(body: unknown): void;
  }

  async function submitCommand(spec: { deviceId: string; commandId: string; command: string; args: Record<string, unknown>; reply: Reply }): Promise<void> {
    const { deviceId, commandId, command, args, reply } = spec;
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
    pendingByHostId.set(hostId, { deviceId, commandId, command });
    // 命令订阅建立（thread 域命令）
    const threadId = typeof args.threadId === "string" ? args.threadId : null;
    const target = fanout.targetOf(deviceId);
    if (threadId !== null && target !== null) target.subscribedThreads.add(threadId);
    const line = JSON.stringify({ ...args, type: command, id: hostId });
    const written = host.write(line);
    if (!written) {
      reply.send({ id: commandId, command, success: false, error: "host unavailable" });
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
    if (command === "gw/logs/tail") return { ok: true, data: { lines: [] } };
    if (command === "gw/shutdown") {
      setTimeout(() => {
        void handle.stop();
      }, 100);
      return { ok: true, data: { stopping: true } };
    }
    if (command === "gw/pairing/start" || command === "gw/pairing/cancel") {
      return { ok: false, reason: "pairing not wired in this batch" };
    }
    return { ok: false, reason: "unknown gw command" };
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
    handleOwnerFrame,
    async stop() {
      await audit.record("gateway-stopped", {});
      await ownerServer.close();
      await host.stop();
    },
  };
  return handle;
}

export { parseFrame };
