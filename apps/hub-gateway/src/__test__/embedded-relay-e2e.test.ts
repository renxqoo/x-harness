import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, type GatewayHandle } from "../main.ts";
import {
  RatchetSession,
  WebSocketFrameReader,
  WebSocketFrameWriter,
  aeadSeal,
  decodeEnvelope,
  deriveInitialChains,
  encodeEnvelope,
  generateSigningKeyPair,
  mixRatchetRoot,
  parseFrame,
  parseNonce,
  buildAad,
  x25519,
  derivePakeChannelKey,
  pakeInitiate,
  devicePakeFinalize,
  type Frame,
} from "@x-harness/remote-protocol";
import { EMBEDDED_RELAY_PORT } from "../relay-bind.ts";

let gw: GatewayHandle;
let agentDir: string;
let relayPortNum: number;
let relayHttpOrigin: string;
let relayHttpHost: string;

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
  agentDir = await mkdtemp(join(tmpdir(), "gw-embedded-"));
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await writeFile(join(agentDir, "gateway.json"), JSON.stringify({ remoteEnabled: true }), "utf8");
  const exec = hostExec();
  gw = await startGateway({ agentDir, hostOverride: { command: exec.command, args: exec.args, env: exec.env }, log: () => {} });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => { setTimeout(r, 200); });
    if (gw.relayLink?.connected()) break;
  }
  if (gw.relayLink?.connected() !== true) throw new Error("embedded relay link never connected");
  relayPortNum = gw.relayBinding.mode === "embedded" ? gw.relayBinding.port : EMBEDDED_RELAY_PORT;
  // 内嵌 relay 绑 0.0.0.0；本机若另有 relay 绑 127.0.0.1，loopback 连接会被它截走
  // （更具体的绑定优先），表现为发现端点 404 且与网关无关。故按实际 relayUrl 取 origin。
  relayHttpOrigin = new URL(gw.relayBinding.relayUrl.replace(/^ws/, "http")).origin;
  relayHttpHost = new URL(relayHttpOrigin).hostname;
}, 30000);

afterAll(async () => {
  await gw.stop();
}, 30000);

async function ownerCommand(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sock = netConnect(gw.ownerServer.socketPath);
  await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  const lines: string[] = [];
  sock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l.length > 0) lines.push(l); });
  const id = body.id as string;
  sock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body })}\n`);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => { setTimeout(r, 50); });
    const hit = lines.find((l) => l.includes(`"id":"${id}"`));
    if (hit !== undefined) {
      sock.destroy();
      return JSON.parse(hit).body as Record<string, unknown>;
    }
  }
  sock.destroy();
  throw new Error(`owner response timeout: ${String(id)}`);
}

async function dialWs(path: string, token: string): Promise<{ send(line: string): void; lines(): string[]; close(): void }> {
  const socket = netConnect({ host: relayHttpHost, port: relayPortNum });
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
    close: () => socket.destroy(),
  };
}

describe("E2E 零配置：内置 relay + 6 位码发现 → PAKE 配对 → ratchet 聊天", () => {
  it("remoteEnabled:true 无 relayUrl → embedded relay 起在固定端口；qr 载荷/manual 码双发", { timeout: 30000 }, async () => {
    expect(gw.relayBinding.mode).toBe("embedded");
    expect(relayPortNum).toBe(EMBEDDED_RELAY_PORT);
    const started = await ownerCommand({ command: "gw/pairing/start", id: "ps1", args: { scope: "interact" } });
    expect(started.success).toBe(true);
    const data = started.data as { qrPayload: string; manualCode: string };
    expect(data.manualCode).toMatch(/^\d{6}$/);
    const qr = JSON.parse(data.qrPayload) as { relayUrl: string; pairingTicket: string };
    expect(qr.relayUrl.startsWith("ws://")).toBe(true);
  });

  it("6 位码发现端点：/api/discover?code=xxx 返回网关接入信息（含 ticket）", { timeout: 30000 }, async () => {
    const started = await ownerCommand({ command: "gw/pairing/start", id: "ps2", args: { scope: "interact" } });
    const { manualCode, pairingId } = started.data as { manualCode: string; pairingId: string };
    const res = await fetch(`${relayHttpOrigin}/api/discover?code=${manualCode}`);
    expect(res.status).toBe(200);
    const hit = (await res.json()) as { relayUrl: string; installationId: string; pairingId: string; pairingTicket: string; gatewayKeyFingerprint: string };
    expect(hit.pairingId).toBe(pairingId);
    expect(hit.installationId).toBe(gw.identity.installationId);
    expect(hit.pairingTicket.split(".")).toHaveLength(3);
    const miss = await fetch(`${relayHttpOrigin}/api/discover?code=000000`);
    expect(miss.status === 404 || miss.status === 200).toBe(true);
  });

  it("完整旅程：6 位码发现 → PAKE → owner SAS 确认 → 设备加密会话 → prompt 聊天 → settled", { timeout: 90000 }, async () => {
    const started = await ownerCommand({ command: "gw/pairing/start", id: "ps3", args: { scope: "interact" } });
    const { manualCode, pairingId } = started.data as { manualCode: string; pairingId: string };
    const discover = await fetch(`${relayHttpOrigin}/api/discover?code=${manualCode}`);
    const hit = (await discover.json()) as { relayUrl: string; installationId: string; pairingTicket: string };
    const installationId = hit.installationId;

    const pairingWire = await dialWs("/pairing", hit.pairingTicket);
    const sendPairing = (payload: unknown): void => {
      pairingWire.send(encodeEnvelope({ v: 1, from: `pairing_${pairingId}`, to: `gw_${installationId}`, payload: Buffer.from(JSON.stringify(payload)).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }));
    };
    const waitPairing = async (pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => { setTimeout(r, 50); });
        for (const line of pairingWire.lines()) {
          const env = decodeEnvelope(line);
          if (env === null) continue;
          try {
            const m = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as Record<string, unknown>;
            if (pred(m)) return m;
          } catch {
          }
        }
      }
      throw new Error("pairing reply timeout");
    };

    const init = pakeInitiate(manualCode);
    sendPairing({ p: "pake-a", pakeA: init.message, deviceInfo: { name: "Code Phone", deviceType: "phone", platform: "ios", appVersion: "1" } });
    const pakeB = await waitPairing((m) => m.p === "pake-b");
    const channelKeyHex = devicePakeFinalize({ code: manualCode, secret: init.state.secret, messageB: pakeB.pakeB as string, gatewayConfirm: pakeB.confirm as string, transcript: pairingId });
    expect(channelKeyHex).not.toBeNull();

    const deviceKeys = generateSigningKeyPair();
    sendPairing({ p: "device-keys", longTermPub: deviceKeys.pub });
    const sas = typeof pakeB.sas === "string" ? pakeB.sas : null;
    expect(sas).toMatch(/^\d{6}$/);
    const confirmed = await ownerCommand({ command: "gw/pairing/confirm", id: "pc3", args: { pairingId, ownerTypedSas: sas, deviceLongTermPub: deviceKeys.pub } });
    expect(confirmed.success).toBe(true);
    const ack = await waitPairing((m) => m.p === "ack" && typeof m.relayToken === "string");
    const deviceToken = ack.relayToken as string;
    const deviceId = ack.deviceId as string;
    pairingWire.close();

    const sharedSecret = mixRatchetRoot(Buffer.from(channelKeyHex!, "hex"), deviceKeys.pub);
    const dataWire = await dialWs("/", deviceToken);
    const ratchet = new RatchetSession(
      { now: Date.now, deviceId, direction: 1, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } },
      deriveInitialChains(sharedSecret, false),
    );
    let seq = 1;
    const decoded: Frame[] = [];
    let cursor = 0;
    const drain = (): void => {
      const pending = dataWire.lines();
      for (; cursor < pending.length; cursor++) {
        const env = decodeEnvelope(pending[cursor]!);
        if (env === null || env.from === "relay") continue;
        const nonce = new Uint8Array(Buffer.from(env.nonce, "base64"));
        const parsed = parseNonce(nonce);
        if (parsed === null) continue;
        void ratchet.open({ ciphertext: new Uint8Array(Buffer.from(env.payload, "base64")), nonce, aad: buildAad(`gw_${installationId}`, `dev_${deviceId}`, parsed.epoch), index: parsed.index, epoch: parsed.epoch }).then((outcome) => {
          if (!outcome.ok) return;
          const frame = parseFrame(Buffer.from(outcome.plaintext).toString("utf8"));
          if (frame !== null) decoded.push(frame);
        });
      }
    };
    const sendCommand = async (id: string, command: string, args: Record<string, unknown>): Promise<void> => {
      const frame: Frame = { kind: "command", streamId: `cmd:${deviceId}`, seq: seq++, body: { command, id, args } };
      const outcome = await ratchet.seal({ plaintext: new TextEncoder().encode(JSON.stringify(frame)), aadFrom: `dev_${deviceId}`, aadTo: `gw_${installationId}` });
      if (!outcome.ok) throw new Error("seal failed");
      const ct = aeadSeal({ key: new Uint8Array(Buffer.from(outcome.keyUsed, "hex")), nonce: outcome.nonce, plaintext: new TextEncoder().encode(JSON.stringify(frame)), aad: outcome.aad });
      dataWire.send(encodeEnvelope({ v: 1, from: `dev_${deviceId}`, to: `gw_${installationId}`, payload: Buffer.from(ct).toString("base64"), nonce: Buffer.from(outcome.nonce).toString("base64") }));
    };
    const waitFrame = async (pred: (f: Frame) => boolean, timeoutMs = 30000): Promise<Frame> => {
      const t0 = Date.now();
      for (;;) {
        drain();
        const hitFrame = decoded.find(pred);
        if (hitFrame !== undefined) return hitFrame;
        if (Date.now() - t0 > timeoutMs) throw new Error(`frame timeout; got ${decoded.length}`);
        await new Promise((r) => { setTimeout(r, 50); });
      }
    };

    await sendCommand("s1", "thread/start", { cwd: process.cwd(), trusted: true });
    const startRes = await waitFrame((f) => f.kind === "response" && (f.body as { id?: string }).id === "s1");
    const startBody = startRes.body as { success: boolean; data?: { threadId?: string } };
    expect(startBody.success).toBe(true);
    const threadId = startBody.data!.threadId!;
    expect(typeof threadId).toBe("string");

    await sendCommand("s2", "prompt", { threadId, message: "say hi" });
    const promptRes = await waitFrame((f) => f.kind === "response" && (f.body as { id?: string }).id === "s2");
    expect((promptRes.body as { success: boolean }).success).toBe(true);

    const seen = new Set<string>();
    await waitFrame((f) => {
      if (f.kind !== "event") return false;
      const body = f.body as { threadId?: string; name?: string };
      if (body.threadId !== threadId) return false;
      seen.add(body.name ?? "");
      return body.name === "settled";
    });
    expect(seen.has("turn/start")).toBe(true);
    dataWire.close();
  });
});

void derivePakeChannelKey;
void x25519;
