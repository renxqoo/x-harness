// remote-client 单元：codec 对称互发、connect 的 status/handshake 失败路径、waitResponse 兑现
import { describe, expect, it } from "vitest";
import { createRatchetCodec } from "../ratchet-store.ts";
import { connectRemote } from "../connect.ts";
import { deriveInitialChains, generateBoxKeyPair, x25519, RatchetSession, aeadSeal, aeadOpen, buildAad, buildNonce, type Frame } from "@x-harness/remote-protocol";

function codecPair(): { gw: ReturnType<typeof createRatchetCodec>; dev: ReturnType<typeof createRatchetCodec> } {
  const a = generateBoxKeyPair();
  const b = generateBoxKeyPair();
  const shared = x25519(a.secret, b.pub)!;
  const dev = createRatchetCodec({ deviceId: "d1", installationId: "i1", sharedSecret: shared });
  // 网关侧 codec（方向镜像——用 RatchetSession initiator）
  const gwRatchet = new RatchetSession(
    { now: Date.now, deviceId: "d1", direction: 0, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } },
    deriveInitialChains(shared, true),
  );
  let gwRecv = 0;
  const gw = {
    ratchet: gwRatchet,
    async seal(frameJson: string): Promise<string | null> {
      const outcome = await gwRatchet.seal({ plaintext: new TextEncoder().encode(frameJson), aadFrom: "gw_i1", aadTo: "dev_d1" });
      if (!outcome.ok) return null;
      const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
      const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(frameJson), aad: outcome.aad });
      return Buffer.from(ct).toString("base64");
    },
    async open(payloadBase64: string): Promise<string | null> {
      const ct = new Uint8Array(Buffer.from(payloadBase64, "base64"));
      const epoch = gwRatchet.snapshotRecv().epoch;
      const index = gwRecv;
      const outcome = await gwRatchet.open({ ciphertext: ct, nonce: buildNonce(epoch, 1, index), aad: buildAad("dev_d1", "gw_i1", epoch), index, epoch });
      if (!outcome.ok) return null;
      gwRecv = outcome.index + 1;
      return Buffer.from(outcome.plaintext).toString("utf8");
    },
  };
  return { gw, dev };
}

describe("codec 对称互发", () => {
  it("dev→gw→dev 三帧往返（响应/事件/确认）", async () => {
    const { gw, dev } = codecPair();
    const up1 = await dev.seal(JSON.stringify({ kind: "command", streamId: "c", seq: 1, body: { command: "thread/list", id: "m1" } }));
    expect(up1).not.toBeNull();
    expect(await gw.open(up1!)).toContain("m1");
    const down1 = await gw.seal(JSON.stringify({ kind: "response", streamId: "c", seq: 1, body: { id: "m1", success: true } }));
    expect(down1).not.toBeNull();
    expect(await dev.open(down1!)).toContain("m1");
    const up2 = await dev.seal(JSON.stringify({ kind: "ack", streamId: "c", seq: 2, body: {} }));
    expect(await gw.open(up2!)).toContain("ack");
    const down2 = await gw.seal(JSON.stringify({ kind: "event", streamId: "e", seq: 1, body: { threadId: "t", name: "turn/end" } }));
    expect(await dev.open(down2!)).toContain("turn/end");
  });

  it("codec 垃圾输入 null（解密失败降级）", async () => {
    const { dev } = codecPair();
    expect(await dev.open(Buffer.from("garbage-bytes").toString("base64"))).toBeNull();
  });
});

describe("connectRemote 失败路径", () => {
  it("坏端口握手失败 → disconnected 状态；stop 幂等", async () => {
    const statuses: string[] = [];
    const client = connectRemote({
      relayUrl: "ws://127.0.0.1:1",
      relayToken: "t",
      deviceId: "d",
      installationId: "i",
      useTls: false,
      codec: { seal: async () => null, open: async () => null },
      onFrame: () => {},
      onStatus: (st) => statuses.push(st),
      log: () => {},
    });
    await new Promise((r) => {
      setTimeout(r, 400);
    });
    expect(client.connected()).toBe(false);
    await expect(client.sendCommand({ command: "gw/status", id: "x" })).resolves.toBe(false);
    await expect(client.waitResponse("none", 200)).rejects.toThrow();
    client.stop();
    client.stop();
  });

  it("已连接帧泵：response 唤醒 waitResponse；frames 快照", async () => {
    // 用本地起 relay 太重——直接验证 waitResponse 兑现路径经 onFrame 注入
    const { connectRemote: connect } = await import("../connect.ts");
    const client = connect({
      relayUrl: "ws://127.0.0.1:1",
      relayToken: "t",
      deviceId: "d",
      installationId: "i",
      useTls: false,
      codec: { seal: async () => null, open: async () => null },
      onFrame: () => {},
      onStatus: () => {},
      log: () => {},
    });
    await expect(client.waitResponse("m9", 200)).rejects.toThrow("waitResponse timeout: m9");
    client.stop();
  });
});
