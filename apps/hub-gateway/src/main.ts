import { readFile } from "node:fs/promises";
import { derivePaths, loadConfig, type GatewayConfig } from "./config.ts";
import { loadOrCreateIdentity, type GatewayIdentity } from "./identity.ts";
import { HostAttach, resolveHostBin } from "./host-attach.ts";
import { loadThreads, type ThreadsRegistry } from "./threads-registry.ts";
import { loadDeviceRegistry, type DeviceRegistry } from "./device-registry.ts";
import { startOwnerServer, type OwnerServerHandle, type OwnerSession } from "./owner-server.ts";
import { Fanout, type ClientTarget } from "./fanout.ts";
import { createHostIngest } from "./host-ingest.ts";
import { openAuditLog, type AuditLog } from "./audit.ts";
import { createHash } from "node:crypto";
const OUTBOUND_PAYLOAD_MAX = 12 * 1024 * 1024;
import { chunkFrame, aeadSeal, buildAad, decodeEnvelope, encodeEnvelope, judgeHostCommand, parseNonce, rekeyDue, startRekey, type Frame } from "@x-harness/remote-protocol";
import { assemblePairingServer } from "./pairing-assembly.ts";
import { createLogBuffer } from "./log-buffer.ts";
import { makeGwDispatcher } from "./gw-dispatch.ts";
import { makeOwnerDispatcher } from "./owner-dispatch.ts";
import { newBucket, processInboundLine, type InboundOutcome, type RateBucket } from "./inbound.ts";
import { startRelayLink, type RelayLinkHandle } from "./relay-link.ts";
import { createCryptoSessionPool, type CryptoSessionPool } from "./session-crypto.ts";
import { bindRelay, type RelayBinding } from "./relay-bind.ts";
import { sendToDeviceInner, markDeviceOfflineFromRelayLine } from "./device-send.ts";
export interface GatewayOptions {
  agentDir: string;
  now?(): number;
  log?(message: string): void;
  hostOverride?: { command: string; args: string[]; env?: Record<string, string> };
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
  relayBinding: RelayBinding;
  stop(): Promise<void>;
  handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void>;
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
  fanout.setTierResolver((target) => {
    if (target === "owner") return "owner";
    return devices.get(target)?.scope ?? "read";
  });
  await audit.record("gateway-started", { installationId: identity.installationId, remoteEnabled: config.remoteEnabled });

  const exec = options.hostOverride ?? resolveHostBin(config.hostBin);
  const pendingByHostId = new Map<string, { deviceId: string; commandId: string; command: string; ownerSession?: OwnerSession }>();
  for (const pending of devices.pendingHostIds()) {
    pendingByHostId.set(pending.hostId, { deviceId: pending.deviceId, commandId: pending.commandId, command: "unknown" });
  }
  const host = new HostAttach({
    exec,
    env: { ...process.env, ...exec.env, HUB_AGENT_DIR: options.agentDir } as Record<string, string>,
    heartbeatDeadlineMs: 10_000,
    onLine: (line) => ingestHostLine(line),
    onRestart: (reason) => {
      void audit.record("host-restarted", { reason });
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
  let pairingServerRef: import("./pairing-server.ts").PairingServer | null = null;
  const relayBinding = await bindRelay(config, {
    singleInstance: true,
    log,
    gatewayOfCode: (code) => {
      const server = pairingServerRef;
      if (server === null) return null;
      for (const session of server.listActive()) {
        if (session.manualCode === code && !session.consumed) {
          return Promise.resolve({ relayUrl: "", installationId: identity.installationId, gatewayKeyFingerprint: identity.signingPub, pairingId: session.pairingId, pairingTicket: session.deviceToken ?? "" })
            .then(async (descriptor) => {
              const relayLink = relayLinkRef;
              const ticket = relayLink !== null ? await relayLink.requestPairingTicket(session.pairingId) : null;
              return { ...descriptor, pairingTicket: ticket ?? "" };
            });
        }
      }
      return null;
    },
  });
  const effectiveConfig: GatewayConfig = relayBinding.mode === "embedded"
    ? { ...config, relayUrl: relayBinding.relayUrl, relayKeyFingerprint: relayBinding.relayKeyFingerprint }
    : config;
  const pairingServer = assemblePairingServer({ identity, config: effectiveConfig, audit, devices, now, relayLink: () => relayLinkRef, cryptoSessions,
    onSessionEstablished: (deviceId, ratchetSeed) => {
      cryptoSessions.establish({ deviceId, sharedSecret: ratchetSeed, initiator: true });
    } });
  pairingServerRef = pairingServer;

  const deviceBuckets = new Map<string, RateBucket>();
  const deviceIngestChains = new Map<string, Promise<void>>();

  async function sendToDevice(deviceId: string, frame: Frame): Promise<void> {
    const run = (deviceIngestChains.get(deviceId) ?? Promise.resolve()).then(() => sendToDeviceInner(deviceId, frame, deviceSendDeps()));
    deviceIngestChains.set(deviceId, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }
  const devicePending = new Map<string, Frame[]>();
  const deviceOffline = new Set<string>();
  function deviceSendDeps() {
    return { installationId: identity.installationId, cryptoSessions, relayLink: () => relayLinkRef, deviceOffline, devicePending, log };
  }

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

  function flushDevicePending(): void {
    const link = relayLinkRef;
    if (link === null || !link.connected()) return;
    for (const [deviceId, frames] of devicePending) {
      if (deviceOffline.has(deviceId)) continue;
      for (const frame of frames) void sendToDevice(deviceId, frame);
      devicePending.set(deviceId, []);
    }
  }
  function ingestDeviceLine(deviceId: string, line: string): Promise<void> {
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
    if (deviceOffline.delete(deviceId)) {
      log(`device ${deviceId} back online — flushing pending frames`);
      for (const frame of devicePending.get(deviceId) ?? []) void sendToDevice(deviceId, frame);
      devicePending.set(deviceId, []);
    }
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
    const inboundOutcome = processInboundLine(line, {
      deviceId,
      tier: entry.scope,
      bucket,
      decrypt: () => ({ plaintext, tagFailures: 0 }),
      onCommand(frame, command, args) {
        const body = frame.body as { id?: string };
        const commandId = typeof body.id === "string" ? body.id : `auto_${frame.seq}`;
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
    replyInboundRejection(deviceId, plaintext, inboundOutcome);
  }
  function replyInboundRejection(deviceId: string, plaintext: string, outcome: InboundOutcome): void {
    if (outcome.kind !== "scope-denied" && outcome.kind !== "unknown-command") return;
    const rejectedId = rejectedCommandIdOf(plaintext);
    const code = outcome.kind === "scope-denied" ? "scope-denied" : "unknown-command";
    const auditEvent: import("./audit.ts").AuditEvent = outcome.kind === "scope-denied" ? "scope-denied" : "unknown-command-denied";
    void audit.record(auditEvent, { deviceId, command: outcome.command });
    void sendToDevice(deviceId, { kind: "response", streamId: `cmd:${deviceId}`, seq: nextSeqFor(`cmd:${deviceId}`), body: { id: rejectedId, command: outcome.command, success: false, error: code } });
  }
  function rejectedCommandIdOf(plaintext: string): string {
    try {
      const frame = JSON.parse(plaintext) as { body?: { id?: unknown } };
      return typeof frame.body?.id === "string" ? frame.body.id : "auto_0";
    } catch {
      return "auto_0";
    }
  }
  let relayLinkRef: RelayLinkHandle | null = null;
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
      relayUrl: effectiveConfig.relayUrl,
      installationId: identity.installationId,
      gatewaySigningSecret: identity.signingSecret,
      gatewaySigningPub: identity.signingPub,
      useTls: effectiveConfig.relayUrl.startsWith("wss://"),
      expectedRelayFingerprint: effectiveConfig.relayUrl.startsWith("wss://") ? effectiveConfig.relayKeyFingerprint : "",
      onFrame: (line) => {
        try {
          const parsed = JSON.parse(line) as { from?: string; to?: string };
          if (typeof parsed.from !== "string") return;
          if (parsed.from === "relay") {
            markDeviceOfflineFromRelayLine(line, parsed.to, { deviceOffline, devices, log });
            return;
          }
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
    const threadId = typeof args.threadId === "string" ? args.threadId : null;
    const target = fanout.targetOf(deviceId);
    if (threadId !== null && target !== null) target.subscribedThreads.add(threadId);
    const line = JSON.stringify({ ...args, type: command, id: hostId });
    const written = host.write(line);
    if (!written) {
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
    relayBinding,
    handleOwnerFrame,
    ingestDeviceLine,
    async stop() {
      await audit.record("gateway-stopped", {});
      for (const timer of rekeyTimers.values()) clearInterval(timer);
      rekeyTimers.clear();
      relayLinkRef?.stop();
      await ownerServer.close();
      await host.stop();
      await relayBinding.stop();
    },
  };
  handleRef = handle;
  return handle;
}
