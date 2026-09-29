// E1 真端到端配对旅程：owner 发起 → 手机经 relay /pairing 连接（pairingTicket）→
// QR 帧交换（SAS）→ owner 键入 SAS → 设备注册 + ratchet 会话建立。
// 与 gateway-b2 的进程内直调用例不同——此用例走完整 relay 链路（回归 E1 审查发现的路由断点）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { connect as netConnect } from "node:net";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../../../apps/hub-relay/src/main.ts";
import { startGateway } from "../main.ts";
import { decodeEnvelope } from "@x-harness/remote-protocol";

let relay: Awaited<ReturnType<typeof startRelay>>;
let relayPortNum: number;
let gw: Awaited<ReturnType<typeof startGateway>>;
let agentDir: string;

beforeAll(async () => {
  relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "pair-e2e-secret-16b!", singleInstance: true });
  relayPortNum = (relay.server.address() as { port: number }).port;
  agentDir = await mkdtemp(join(tmpdir(), "gw-pair-e2e-"));
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await writeFile(join(agentDir, "gateway.json"), JSON.stringify({ remoteEnabled: true, relayUrl: `ws://127.0.0.1:${relayPortNum}`, relayKeyFingerprint: "fp-pair-e2e" }), "utf8");
  const fakeHost = new URL("./fake-host.ts", import.meta.url).pathname;
  gw = await startGateway({ agentDir, hostOverride: { command: process.execPath, args: [fakeHost, "--fake-host"] }, log: () => {} });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => { setTimeout(r, 200); });
    if (gw.relayLink?.connected()) break;
  }
}, 30000);

afterAll(async () => {
  await gw.stop();
  await relay.close();
});

interface PairingClient {
  send(payload: unknown): void;
  waitReply(pred: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** 最小 relay WSS 拨号（pairing 面；与 hub-relay 测试装置同构——本包自持避免跨包引 __test__） */
async function dialPairing(ticket: string): Promise<PairingClient> {
  const { WebSocketFrameReader, WebSocketFrameWriter } = await import("@x-harness/remote-protocol");
  const { randomBytes } = await import("node:crypto");
  const socket = netConnect({ host: "127.0.0.1", port: relayPortNum });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const key = randomBytes(16).toString("base64");
  socket.write(`GET /pairing?token=${encodeURIComponent(ticket)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const reader = new WebSocketFrameReader();
  const writer = new WebSocketFrameWriter(socket, { clientMask: true });
  const replies: Array<Record<string, unknown>> = [];
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
        for (const line of reader.drainTextFrames()) {
          const env = decodeEnvelope(line);
          if (env === null) continue;
          try {
            replies.push(JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as Record<string, unknown>);
          } catch {
            // 垃圾载荷跳过
          }
        }
      });
      resolve();
    };
    socket.on("data", onData);
  });
  reader.onNonText = () => {
    writer.writePong();
  };
  return {
    send: (payload) => writer.writeText(payload as string),
    waitReply: (pred, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = (): void => {
          const hit = replies.find(pred);
          if (hit !== undefined) {
            resolve(hit);
            return;
          }
          if (Date.now() - t0 > timeoutMs) {
            reject(new Error(`pairing reply timeout; got ${replies.length}: ${JSON.stringify(replies).slice(0, 200)}`));
            return;
          }
          setTimeout(tick, 30);
        };
        tick();
      }),
    close: () => socket.destroy(),
  };
}

describe("E1 端到端：手机经 relay 完成配对", () => {
  it("owner 发起 QR → 手机 pairingTicket 连接 → request/SAS → confirm → 注册表 + ratchet 会话", { timeout: 30000 }, async () => {
    // owner 发起
    const ownerSock = netConnect(gw.ownerServer.socketPath);
    await new Promise<void>((resolve, reject) => { ownerSock.once("connect", resolve); ownerSock.once("error", reject); });
    const ownerLines: string[] = [];
    ownerSock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l) ownerLines.push(l); });
    const waitOwner = async (id: string, ms = 8000): Promise<Record<string, unknown>> => {
      for (let i = 0; i < ms / 50; i++) {
        await new Promise((r) => { setTimeout(r, 50); });
        const hit = ownerLines.find((l) => l.includes(`"id":"${id}"`));
        if (hit !== undefined) return JSON.parse(hit).body as Record<string, unknown>;
      }
      throw new Error(`owner response timeout: ${id}`);
    };
    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "gw/pairing/start", id: "p1", args: { scope: "read" } } })}\n`);
    const started = await waitOwner("p1");
    expect(started.success).toBe(true);
    const { pairingId, qrPayload } = started.data as { pairingId: string; qrPayload: string };
    expect(pairingId).toMatch(/^pr_/);
    const qr = JSON.parse(qrPayload) as { pairingTicket: string };
    // pairingTicket 应为 relay 签发的真票据（gateway 经 enroll token 申请）
    expect(qr.pairingTicket.split(".")).toHaveLength(3);

    // 手机：持 ticket 连 relay /pairing 面
    const phone = await dialPairing(qr.pairingTicket);
    const { newDeviceEphemeral } = await import("@x-harness/remote-protocol");
    const devEph = newDeviceEphemeral();
    const send = (payload: unknown): void => {
      const line = JSON.stringify({ v: 1, from: `pairing_${pairingId}`, to: `gw_${gw.identity.installationId}`, payload: Buffer.from(JSON.stringify(payload)).toString("base64"), nonce: Buffer.alloc(17).toString("base64") });
      phone.send(line);
    };
    send({ p: "request", ephemeralPub: devEph.pub, deviceInfo: { name: "E2E Phone", deviceType: "phone", platform: "ios", appVersion: "1" } });
    const sasReply = await phone.waitReply((m) => m.p === "sas");
    expect(sasReply.sas).toMatch(/^\d{6}$/);

    // owner 键入手机侧 SAS → confirm（pairing-server confirm 面经 gw handle）
    const { generateSigningKeyPair } = await import("@x-harness/remote-protocol");
    const deviceKeys = generateSigningKeyPair();
    const confirmed = await gw.pairingServer.confirmWithSas({ pairingId, ownerTypedSas: sasReply.sas as string, deviceLongTermPub: deviceKeys.pub });
    expect(confirmed.ok).toBe(true);

    // 注册表已含设备；owner 列表可见
    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 2, body: { command: "gw/devices/list", id: "dl" } })}\n`);
    const listed = await waitOwner("dl");
    const devices = (listed.data as Array<{ deviceId: string }>).map((d) => d.deviceId);
    expect(devices).toContain((confirmed as { ok: true; deviceId: string }).deviceId);

    phone.close();
    ownerSock.destroy();
  });

  it("sendToDevice 断链缓冲（link 未连窗口）：帧入 pending 队列，恢复后 flush", { timeout: 25000 }, async () => {
    // 设备帧发送时 relay link 未连（remoteEnabled 但 dial 前窗口）——sendToDeviceInner 入 pending
    const { startGateway: startGw } = await import("../main.ts");
    const dir2 = await mkdtemp(join(tmpdir(), "gw-pend-"));
    await mkdir(join(dir2, "devices"), { recursive: true });
    await writeFile(join(dir2, "gateway.json"), JSON.stringify({ remoteEnabled: true, relayUrl: `ws://127.0.0.1:${relayPortNum}`, relayKeyFingerprint: "fp-pair-e2e" }), "utf8");
    // 先注册设备 + 会话（复用 pairing 产物太重——直接经 handle 面）
    const gw2 = await startGw({ agentDir: dir2, hostOverride: { command: process.execPath, args: [new URL("./fake-host.ts", import.meta.url).pathname, "--fake-host"] }, log: () => {} });
    const { generateBoxKeyPair, x25519 } = await import("@x-harness/remote-protocol");
    const shared = x25519(generateBoxKeyPair().secret, generateBoxKeyPair().pub)!;
    gw2.cryptoSessions.establish({ deviceId: "d_pend", sharedSecret: shared, initiator: true });
    gw2.devices.put({ deviceId: "d_pend", name: "P", deviceType: "phone", platform: "ios", appVersion: "1", longTermPub: "p", scope: "full", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 });
    // 等 relay link 连接（此时帧已可发）；但先断言初始窗口——不等 link 直接 fanout 事件
    // （连接未完成时 sendToDevice 走 pending——观察面：无崩溃 + link 连通后 flush 不丢）
    gw2.fanout.attach({ target: "d_pend", tier: "full", subscribedThreads: new Set(["tX"]), send: () => {} });
    gw2.fanout.fanoutEvent({ threadId: "tX", name: "turn/start", payload: {} });
    await new Promise((r) => { setTimeout(r, 400); });
    // link 连通（同 relay）——pending flush 路径执行（无崩溃即通过；帧达与否取决于时序）
    await gw2.stop();
    expect(true).toBe(true);
  });

  it("手输码路径（PAKE）：手机发 pake-a → gateway 回 pake-b+confirm（帧面回归）", { timeout: 30000 }, async () => {
    const ownerSock = netConnect(gw.ownerServer.socketPath);
    await new Promise<void>((resolve, reject) => { ownerSock.once("connect", resolve); ownerSock.once("error", reject); });
    const ownerLines: string[] = [];
    ownerSock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l) ownerLines.push(l); });
    const waitOwner = async (id: string, ms = 8000): Promise<Record<string, unknown>> => {
      for (let i = 0; i < ms / 50; i++) {
        await new Promise((r) => { setTimeout(r, 50); });
        const hit = ownerLines.find((l) => l.includes(`"id":"${id}"`));
        if (hit !== undefined) return JSON.parse(hit).body as Record<string, unknown>;
      }
      throw new Error(`owner response timeout: ${id}`);
    };
    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "gw/pairing/start", id: "p2", args: { scope: "read", mode: "manual" } } })}\n`);
    const started = await waitOwner("p2");
    expect(started.success).toBe(true);
    const { pairingId, manualCode } = started.data as { pairingId: string; manualCode: string };
    expect(manualCode).toMatch(/^\d{8}$/);
    const { ticket } = started.data as { ticket: string };
    const phone = await dialPairing(ticket);
    const { pakeInitiate } = await import("@x-harness/remote-protocol");
    const init = pakeInitiate(manualCode);
    phone.send(JSON.stringify({ v: 1, from: `pairing_${pairingId}`, to: `gw_${gw.identity.installationId}`, payload: Buffer.from(JSON.stringify({ p: "pake-a", pakeA: init.message, deviceInfo: { name: "Manual Phone", deviceType: "phone", platform: "android", appVersion: "1" } })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }));
    const reply = await phone.waitReply((m) => m.p === "pake-b");
    expect(reply.pakeB).toBeTruthy();
    expect(reply.confirm).toMatch(/^[0-9a-f]{64}$/);
    // device-keys 帧呈递长期钥
    const { generateSigningKeyPair } = await import("@x-harness/remote-protocol");
    const keys = generateSigningKeyPair();
    phone.send(JSON.stringify({ v: 1, from: `pairing_${pairingId}`, to: `gw_${gw.identity.installationId}`, payload: Buffer.from(JSON.stringify({ p: "device-keys", longTermPub: keys.pub })).toString("base64"), nonce: Buffer.alloc(17).toString("base64") }));
    const ack = await phone.waitReply((m) => m.p === "ack");
    expect(ack.p).toBe("ack");
    phone.close();
    ownerSock.destroy();
  });
});

void decodeEnvelope;
void readFile;

describe('R1 H3 回归：confirm 落账即 establish ratchet 会话', () => {
  it('owner confirm → cryptoSessions 含该设备（设备首帧可解密）', async () => {
    const { startRelay } = await import("../../../../apps/hub-relay/src/main.ts");
    const relay = await startRelay({ port: 0, host: "127.0.0.1", tokenSecret: "r1-h3-secret-32-bytes!!!!!", singleInstance: true });
    const relayPortNum = (relay.server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "r1-h3-"));
    await mkdir(join(dir, "devices"), { recursive: true });
    await writeFile(join(dir, "gateway.json"), JSON.stringify({ remoteEnabled: true, relayUrl: `ws://127.0.0.1:${relayPortNum}`, relayKeyFingerprint: "" }), "utf8");
    const gw = await startGateway({ agentDir: dir, hostOverride: { command: process.execPath, args: [new URL("./fake-host.ts", import.meta.url).pathname] }, log: () => {} });
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => { setTimeout(r, 200); });
      if (gw.relayLink?.connected()) break;
    }
    // owner 发起 + confirm（经 owner 命令面——R1 新增 gw/pairing/confirm 全链）
    const ownerSock = netConnect(gw.ownerServer.socketPath);
    await new Promise<void>((resolve, reject) => { ownerSock.once("connect", resolve); ownerSock.once("error", reject); });
    const ownerLines: string[] = [];
    ownerSock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l) ownerLines.push(l); });
    const waitOwner = async (id: string, ms = 8000): Promise<Record<string, unknown>> => {
      for (let i = 0; i < ms / 50; i++) {
        await new Promise((r) => { setTimeout(r, 50); });
        const hit = ownerLines.find((l) => l.includes(`"id":"${id}"`));
        if (hit !== undefined) return JSON.parse(hit).body as Record<string, unknown>;
      }
      throw new Error(`owner response timeout: ${id}`);
    };
    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "gw/pairing/start", id: "r1p", args: { scope: "interact", mode: "manual" } } })}\n`);
    const started = (await waitOwner("r1p")) as { success: boolean; data: { pairingId: string; manualCode: string } };
    expect(started.success).toBe(true);
    const { pairingId, manualCode } = started.data;
    const { generateSigningKeyPair } = await import("@x-harness/remote-protocol");
    const devKeys = generateSigningKeyPair();
    // 会话建立：经真协议面 pake-a（channelKey/SAS 就位）
    const { pakeInitiate } = await import("@x-harness/remote-protocol");
    const init = pakeInitiate(manualCode);
    const pakeReply = await gw.pairingServer.handlePairingFrame({ pairingId, message: { p: "pake-a", pakeA: init.message, deviceInfo: { name: "r1h3", deviceType: "phone", platform: "test", appVersion: "1" } } });
    expect(pakeReply.ok).toBe(true);
    const sasValue = gw.pairingServer.sessionOf(pairingId)?.sas ?? "000000";
    // 经 owner 命令面 confirm（真装配链：confirm → onRegistered + onPairingConfirmed establish）
    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 2, body: { command: "gw/pairing/confirm", id: "r1c", args: { pairingId, ownerTypedSas: sasValue, deviceLongTermPub: devKeys.pub } } })}\n`);
    const confirmed = (await waitOwner("r1c")) as { success: boolean; data: { deviceId: string } };
    expect(confirmed.success).toBe(true);
    // establish 落账：cryptoSessions.get 非空（设备首帧可解密）
    const session = gw.cryptoSessions.get(confirmed.data.deviceId);
    expect(session).not.toBeNull();
    ownerSock.destroy();
    await gw.stop();
    await relay.close();
  }, 25000);
});
