import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../../../apps/hub-relay/src/main.ts";
import { startGateway, type GatewayHandle } from "../main.ts";
import {
  RatchetSession,
  WebSocketFrameReader,
  WebSocketFrameWriter,
  aeadSeal,
  decodeEnvelope,
  deriveInitialChains,
  encodeEnvelope,
  generateBoxKeyPair,
  generateSigningKeyPair,
  mixRatchetRoot,
  newDeviceEphemeral,
  parseFrame,
  parseNonce,
  buildAad,
  x25519,
  derivePakeChannelKey,
  type Frame,
} from "@x-harness/remote-protocol";

let relay: Awaited<ReturnType<typeof startRelay>>;
let relayPortNum: number;
let gw: GatewayHandle;
let agentDir: string;

function hostExec(): { command: string; args: string[]; env: Record<string, string> } {
  const entry = join(process.cwd(), "apps/host-hub/src/host/cli.ts");
  return {
    command: process.execPath,
    args: [entry],
    env: {
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "hello from scripted llm" }]),
      HUB_SKILLS_MIGRATION: "0",
      HUB_AGENTS_MIGRATION: "0",
    },
  };
}

beforeAll(async () => {
  relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "device-chat-secret-16b!!", singleInstance: true });
  relayPortNum = (relay.server.address() as { port: number }).port;
  agentDir = await mkdtemp(join(tmpdir(), "gw-device-chat-"));
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await writeFile(join(agentDir, "gateway.json"), JSON.stringify({ remoteEnabled: true, relayUrl: `ws://127.0.0.1:${relayPortNum}`, relayKeyFingerprint: "fp-device-chat" }), "utf8");
  const exec = hostExec();
  gw = await startGateway({ agentDir, hostOverride: { command: exec.command, args: exec.args, env: exec.env }, log: () => {} });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => { setTimeout(r, 200); });
    if (gw.relayLink?.connected()) break;
  }
  if (gw.relayLink?.connected() !== true) throw new Error("gateway relay link never connected");
}, 30000);

afterAll(async () => {
  await gw.stop();
  await relay.close();
}, 30000);

async function dialWs(path: string, token: string): Promise<{ send(line: string): void; lines(): string[]; waitLine(pred: (line: string) => boolean, timeoutMs?: number): Promise<string>; close(): void }> {
  const socket = netConnect({ host: "127.0.0.1", port: relayPortNum });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const key = randomBytes(16).toString("base64");
  socket.write(`GET ${path}?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const reader = new WebSocketFrameReader();
  const writer = new WebSocketFrameWriter(socket, { clientMask: true });
  const inbound: string[] = [];
  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (!buf.includes("\r\n\r\n")) return;
      const head = buf.subarray(0, buf.indexOf("\r\n\r\n")).toString();
      if (!head.includes("101")) {
        reject(new Error(`handshake failed: ${head.split("\r\n")[0]}`));
        return;
      }
      socket.off("data", onData);
      const rest = buf.subarray(buf.indexOf("\r\n\r\n") + 4);
      if (rest.length > 0) reader.push(rest);
      socket.on("data", (c: Buffer) => {
        reader.push(c);
        for (const line of reader.drainTextFrames()) inbound.push(line);
      });
      resolve();
    };
    socket.on("data", onData);
  });
  reader.onNonText = () => { writer.writePong(); };
  return {
    send: (line) => writer.writeText(line),
    lines: () => [...inbound],
    waitLine: (pred, timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = (): void => {
          const hit = inbound.find(pred);
          if (hit !== undefined) { resolve(hit); return; }
          if (Date.now() - t0 > timeoutMs) { reject(new Error(`line timeout; got ${inbound.length} lines`)); return; }
          setTimeout(tick, 30);
        };
        tick();
      }),
    close: () => socket.destroy(),
  };
}

interface DeviceSession {
  deviceId: string;
  sendSealed(frame: Frame): Promise<void>;
  waitDecoded(pred: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  sendCommand(id: string, command: string, args: Record<string, unknown>): Promise<void>;
  waitResponse(id: string, timeoutMs?: number): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  close(): void;
}

async function pairDevice(scope: "read" | "interact" | "full"): Promise<DeviceSession> {
  const ownerSock = netConnect(gw.ownerServer.socketPath);
  await new Promise<void>((resolve, reject) => { ownerSock.once("connect", resolve); ownerSock.once("error", reject); });
  const ownerLines: string[] = [];
  ownerSock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l.length > 0) ownerLines.push(l); });
  const waitOwner = async (id: string, ms = 10000): Promise<Record<string, unknown>> => {
    for (let i = 0; i < ms / 50; i++) {
      await new Promise((r) => { setTimeout(r, 50); });
      const hit = ownerLines.find((l) => l.includes(`"id":"${id}"`));
      if (hit !== undefined) return JSON.parse(hit).body as Record<string, unknown>;
    }
    throw new Error(`owner response timeout: ${id}`);
  };
  ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "gw/pairing/start", id: "ps", args: { scope } } })}\n`);
  const started = await waitOwner("ps");
  expect(started.success).toBe(true);
  const { pairingId, qrPayload } = started.data as { pairingId: string; qrPayload: string };
  const qr = JSON.parse(qrPayload) as { pairingTicket: string; gwEphemeralPub: string; installationId: string; relayUrl: string };

  const pairingWire = await dialWs("/pairing", qr.pairingTicket);
  const devEph = newDeviceEphemeral();
  const sendPairing = (payload: unknown): void => {
    pairingWire.send(encodeEnvelope({ v: 1, from: `pairing_${pairingId}`, to: `gw_${qr.installationId}`, payload: Buffer.from(JSON.stringify(payload)).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }));
  };
  const waitPairing = async (pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const line = await pairingWire.waitLine((l) => {
      const env = decodeEnvelope(l);
      if (env === null) return false;
      try { return pred(JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as Record<string, unknown>); } catch { return false; }
    });
    const env = decodeEnvelope(line)!;
    return JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as Record<string, unknown>;
  };
  sendPairing({ p: "request", ephemeralPub: devEph.pub, deviceInfo: { name: "E2E Chat Phone", deviceType: "phone", platform: "ios", appVersion: "1" } });
  const sasReply = await waitPairing((m) => m.p === "sas");
  expect(sasReply.sas).toMatch(/^\d{6}$/);

  const deviceKeys = generateSigningKeyPair();
  sendPairing({ p: "device-keys", longTermPub: deviceKeys.pub });
  ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 2, body: { command: "gw/pairing/confirm", id: "pc", args: { pairingId, ownerTypedSas: sasReply.sas, deviceLongTermPub: deviceKeys.pub } } })}\n`);
  const confirmedOwner = await waitOwner("pc");
  expect(confirmedOwner.success).toBe(true);
  ownerSock.destroy();
  const ack = await waitPairing((m) => m.p === "ack" && typeof m.relayToken === "string");
  const deviceToken = ack.relayToken as string;
  const deviceId = ack.deviceId as string;
  pairingWire.close();

  const dh = x25519(devEph.secret, qr.gwEphemeralPub);
  if (dh === null) throw new Error("device dh failed");
  const channelKey = derivePakeChannelKey(Buffer.from(dh).toString("hex"));
  const sharedSecret = mixRatchetRoot(channelKey, deviceKeys.pub);
  const installationId = qr.installationId;

  const dataWire = await dialWs("/", deviceToken);
  const ratchet = new RatchetSession(
    { now: Date.now, deviceId, direction: 1, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } },
    deriveInitialChains(sharedSecret, false),
  );
  let seq = 1;
  const decoded: Frame[] = [];
  let decodedCursor = 0;
  const decodeLoop = (): void => {
    const pending = dataWire.lines();
    for (; decodedCursor < pending.length; decodedCursor++) {
      const line = pending[decodedCursor]!;
      const env = decodeEnvelope(line);
      if (env === null || env.from === "relay") continue;
      const ct = new Uint8Array(Buffer.from(env.payload, "base64"));
      const nonce = new Uint8Array(Buffer.from(env.nonce, "base64"));
      const parsed = parseNonce(nonce);
      if (parsed === null) continue;
      void ratchet.open({ ciphertext: ct, nonce, aad: buildAad(`gw_${installationId}`, `dev_${deviceId}`, parsed.epoch), index: parsed.index, epoch: parsed.epoch }).then((outcome) => {
        if (!outcome.ok) return;
        const frame = parseFrame(Buffer.from(outcome.plaintext).toString("utf8"));
        if (frame !== null) decoded.push(frame);
      });
    }
  };
  const session: DeviceSession = {
    deviceId,
    async sendSealed(frame) {
      const outcome = await ratchet.seal({ plaintext: new TextEncoder().encode(JSON.stringify(frame)), aadFrom: `dev_${deviceId}`, aadTo: `gw_${installationId}` });
      if (!outcome.ok) throw new Error("seal failed");
      const ct = aeadSeal({ key: new Uint8Array(Buffer.from(outcome.keyUsed, "hex")), nonce: outcome.nonce, plaintext: new TextEncoder().encode(JSON.stringify(frame)), aad: outcome.aad });
      dataWire.send(encodeEnvelope({ v: 1, from: `dev_${deviceId}`, to: `gw_${installationId}`, payload: Buffer.from(ct).toString("base64"), nonce: Buffer.from(outcome.nonce).toString("base64") }));
    },
    async waitDecoded(pred, timeoutMs = 20000) {
      const t0 = Date.now();
      for (;;) {
        decodeLoop();
        const hit = decoded.find(pred);
        if (hit !== undefined) return hit;
        if (Date.now() - t0 > timeoutMs) throw new Error(`decoded frame timeout; got ${decoded.length} frames, raw lines=${dataWire.lines().length}: ${decoded.map((f) => f.kind).join(",")}`);
        await new Promise((r) => { setTimeout(r, 50); });
      }
    },
    async sendCommand(id, command, args) {
      await session.sendSealed({ kind: "command", streamId: `cmd:${deviceId}`, seq: seq++, body: { command, id, args } });
    },
    async waitResponse(id, timeoutMs) {
      const frame = await session.waitDecoded((f) => f.kind === "response" && (f.body as { id?: string }).id === id, timeoutMs);
      return frame.body as { success: boolean; data?: unknown; error?: unknown };
    },
    close: () => dataWire.close(),
  };
  return session;
}

describe("E2E 设备加密会话：配对 → ratchet 通道 → host 聊天", () => {
  it("interact 设备：thread/start → prompt → 剧本回复事件 + response 回流（全程 E2E 加密）", { timeout: 90000 }, async () => {
    const device = await pairDevice("interact");
    await device.sendCommand("c1", "thread/list", {});
    const listRes = await device.waitResponse("c1");
    expect(listRes.success).toBe(true);

    await device.sendCommand("c2", "thread/start", { cwd: process.cwd(), trusted: true });
    const startRes = await device.waitResponse("c2");
    expect(startRes.success).toBe(true);
    const threadId = (startRes.data as { threadId?: string }).threadId;
    expect(typeof threadId).toBe("string");

    await device.sendCommand("c3", "prompt", { threadId, message: "say hi" });
    const promptRes = await device.waitResponse("c3");
    expect(promptRes.success).toBe(true);

    const seen = new Set<string>();
    await device.waitDecoded((f) => {
      if (f.kind !== "event") return false;
      const body = f.body as { threadId?: string; name?: string };
      if (body.threadId !== threadId) return false;
      seen.add(body.name ?? "");
      return body.name === "settled";
    }, 30000);
    expect(seen.has("turn/start")).toBe(true);
    device.close();
  }, );

  it("read 设备：prompt 被 scope 拒（scope-denied）——权限矩阵真链路回归", { timeout: 60000 }, async () => {
    const device = await pairDevice("read");
    await device.sendCommand("c1", "thread/list", {});
    const listRes = await device.waitResponse("c1");
    expect(listRes.success).toBe(true);

    await device.sendCommand("c2", "prompt", { threadId: "t", message: "x" });
    const denied = await device.waitResponse("c2");
    expect(denied.success).toBe(false);
    expect(denied.error).toBe("scope-denied");
    device.close();
  });
});

void generateBoxKeyPair;
void mkdir;
