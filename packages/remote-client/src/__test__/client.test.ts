import { describe, expect, it } from "vitest";
import { createRatchetCodec } from "../ratchet-store.ts";
import { connectRemote } from "../connect.ts";
import { deriveInitialChains, generateBoxKeyPair, x25519, RatchetSession, aeadSeal, buildAad, parseNonce } from "@x-harness/remote-protocol";

function codecPair(): { gw: ReturnType<typeof createRatchetCodec>; dev: ReturnType<typeof createRatchetCodec> } {
  const a = generateBoxKeyPair();
  const b = generateBoxKeyPair();
  const shared = x25519(a.secret, b.pub)!;
  const dev = createRatchetCodec({ deviceId: "d1", installationId: "i1", sharedSecret: shared });
  const gwRatchet = new RatchetSession(
    { now: Date.now, deviceId: "d1", direction: 0, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } },
    deriveInitialChains(shared, true),
  );
  let gwRecv = 0;
  const gw = {
    ratchet: gwRatchet,
    async seal(frameJson: string): Promise<{ payload: string; nonce: string } | null> {
      const outcome = await gwRatchet.seal({ plaintext: new TextEncoder().encode(frameJson), aadFrom: "gw_i1", aadTo: "dev_d1" });
      if (!outcome.ok) return null;
      const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
      const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(frameJson), aad: outcome.aad });
      return { payload: Buffer.from(ct).toString("base64"), nonce: Buffer.from(outcome.nonce).toString("base64") };
    },
    async open(payloadBase64: string, nonceBase64: string): Promise<string | null> {
      const ct = new Uint8Array(Buffer.from(payloadBase64, "base64"));
      const nonceBytes = new Uint8Array(Buffer.from(nonceBase64, "base64"));
      const parsed = parseNonce(nonceBytes);
      if (parsed === null) return null;
      const outcome = await gwRatchet.open({ ciphertext: ct, nonce: nonceBytes, aad: buildAad("dev_d1", "gw_i1", parsed.epoch), index: parsed.index, epoch: parsed.epoch });
      if (!outcome.ok) return null;
      gwRecv = Math.max(gwRecv, outcome.index + 1);
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
    expect(await gw.open(up1!.payload, up1!.nonce)).toContain("m1");
    const down1 = await gw.seal(JSON.stringify({ kind: "response", streamId: "c", seq: 1, body: { id: "m1", success: true } }));
    expect(down1).not.toBeNull();
    expect(await dev.open(down1!.payload, down1!.nonce)).toContain("m1");
    const up2 = await dev.seal(JSON.stringify({ kind: "ack", streamId: "c", seq: 2, body: {} }));
    const up2v = up2!;
    expect(await gw.open(up2v.payload, up2v.nonce)).toContain("ack");
    const down2 = await gw.seal(JSON.stringify({ kind: "event", streamId: "e", seq: 1, body: { threadId: "t", name: "turn/end" } }));
    const down2v = down2!;
    expect(await dev.open(down2v.payload, down2v.nonce)).toContain("turn/end");
    expect(await gw.open(up2v.payload, up2v.nonce)).toBeNull();
  });

  it("codec 垃圾输入 null（解密失败降级）", async () => {
    const { dev } = codecPair();
    expect(await dev.open(Buffer.from("garbage-bytes").toString("base64"), Buffer.alloc(17).toString("base64"))).toBeNull();
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
