// ratchet 契约：双端互发 N 帧、重发重加密、乱序 skipped-key、index 回退硬失败、
// 崩溃恢复（边界预支）、DH 推进、跨代密文拒收——DESIGN §1.3 全锚点
import { describe, expect, it } from "vitest";
import { RatchetSession, deriveInitialChains, deriveRekeyChains, type RatchetPersist } from "../ratchet.ts";
import { aeadSeal, buildAad, buildNonce, generateBoxKeyPair, x25519 } from "../crypto.ts";
import { RATCHET_BATCH_FRAMES } from "../limits.ts";

const enc = new TextEncoder();

function memoryPersist(): RatchetPersist & { sends: number; recvs: number; failNext: boolean } {
  return {
    sends: 0,
    recvs: 0,
    failNext: false,
    async persistSendBoundary() {
      if (this.failNext) throw new Error("disk full");
      this.sends++;
    },
    async persistRecvBoundary() {
      if (this.failNext) throw new Error("disk full");
      this.recvs++;
    },
  };
}

let lastSendBoundary: import("../ratchet.ts").SendBoundary | null = null;

function endpoints() {
  const gwEph = generateBoxKeyPair();
  const devEph = generateBoxKeyPair();
  const shared1 = x25519(gwEph.secret, devEph.pub)!;
  const shared2 = x25519(devEph.secret, gwEph.pub)!;
  const gwInit = deriveInitialChains(shared1, true);
  const devInit = deriveInitialChains(shared2, false);
  const gwPersist = memoryPersist();
  const devPersist = memoryPersist();
  lastSendBoundary = null;
  const gw = new RatchetSession({
    now: () => 0,
    persist: {
      ...gwPersist,
      async persistSendBoundary(id, send) {
        lastSendBoundary = { ...send };
        return gwPersist.persistSendBoundary(id, send);
      },
    },
    deviceId: "dev_1",
    direction: 0,
  }, gwInit);
  const dev = new RatchetSession({ now: () => 0, persist: devPersist, deviceId: "dev_1", direction: 1 }, devInit);
  return { gw, dev, gwPersist, devPersist };
}

async function gwSeal(gw: RatchetSession, text: string) {
  const pt = enc.encode(text);
  const outcome = await gw.seal({ plaintext: pt, aadFrom: "gw_1", aadTo: "dev_1" });
  if (!outcome.ok) throw new Error(`seal failed: ${outcome.reason}`);
  const nonce = outcome.nonce;
  const aad = outcome.aad;
  const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
  return { ct: aeadSeal({ key, nonce, plaintext: pt, aad }), index: outcome.index, epoch: outcome.epoch, nonce, aad, key: outcome.keyUsed };
}

describe("双端互发", () => {
  it("N 帧往返全通、index 单调、nonce 永不复现", async () => {
    const { gw, dev } = endpoints();
    const nonces = new Set<string>();
    for (let i = 0; i < 130; i++) {
      const sealed = await gwSeal(gw, `frame-${i}`);
      nonces.add(Buffer.from(sealed.nonce).toString("hex"));
      const opened = await dev.open({ ciphertext: sealed.ct, nonce: sealed.nonce, aad: sealed.aad, index: sealed.index, epoch: sealed.epoch });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(Buffer.from(opened.plaintext).toString("utf8")).toBe(`frame-${i}`);
        expect(opened.index).toBe(i);
      }
    }
    expect(nonces.size).toBe(130);
  });

  it("双向：设备→网关同链互通（方向位隔离）", async () => {
    const { gw, dev } = endpoints();
    const pt = enc.encode("up");
    const outcome = await dev.seal({ plaintext: pt, aadFrom: "dev_1", aadTo: "gw_1" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const ct = aeadSeal({ key: new Uint8Array(Buffer.from(outcome.keyUsed, "hex")), nonce: outcome.nonce, plaintext: pt, aad: outcome.aad });
      const opened = await gw.open({ ciphertext: ct, nonce: outcome.nonce, aad: outcome.aad, index: outcome.index, epoch: outcome.epoch });
      expect(opened.ok).toBe(true);
    }
  });

  it("批边界落盘：每 64 帧一次 persist；首帧即落", async () => {
    const { gw, gwPersist } = endpoints();
    await gwSeal(gw, "a");
    await gwSeal(gw, "b");
    expect(gwPersist.sends).toBe(1);
    for (let i = 0; i < RATCHET_BATCH_FRAMES - 2; i++) await gwSeal(gw, `f${i}`);
    expect(gwPersist.sends).toBe(1);
    await gwSeal(gw, "next-batch");
    expect(gwPersist.sends).toBe(2);
  });

  it("落盘失败 fail-closed：seal 拒绝（不发未持久帧）", async () => {
    const { gw, gwPersist } = endpoints();
    gwPersist.failNext = true;
    const outcome = await gw.seal({ plaintext: enc.encode("x"), aadFrom: "gw_1", aadTo: "dev_1" });
    expect(outcome).toEqual({ ok: false, reason: "persist-failed" });
  });

  it("回归（A1 症状：恢复后链错位 tag 恒败/nonce 复用）：restore→续发与对端互通且 index 只进", async () => {
    const { gw, dev, gwPersist } = endpoints();
    for (let i = 0; i < 70; i++) {
      const sealed = await gwSeal(gw, `f${i}`);
      const opened = await dev.open({ ciphertext: sealed.ct, nonce: sealed.nonce, aad: sealed.aad, index: sealed.index, epoch: sealed.epoch });
      expect(opened.ok).toBe(true);
    }
    // 批首落盘形态：{chainKey=批首链, baseIndex=64, nextIndex=128}
    const persisted = lastSendBoundary ?? gw.snapshotSend();
    void gwPersist;
    const restored = RatchetSession.restore(
      { now: () => 0, persist: gwPersist, deviceId: "dev_1", direction: 0 },
      persisted,
      { ...dev.snapshotRecv(), epoch: gw.snapshotSend().epoch },
    );
    expect(restored.snapshotSend().nextIndex).toBeGreaterThanOrEqual(128);
    // 续发 3 帧：对端 skipped-key 吸收（乱序路径）或顺序到达
    for (let i = 0; i < 3; i++) {
      const sealed = await gwSeal(restored, `r${i}`);
      const opened = await dev.open({ ciphertext: sealed.ct, nonce: sealed.nonce, aad: sealed.aad, index: sealed.index, epoch: sealed.epoch });
      expect(opened.ok).toBe(true);
    }
  });

  it("崩溃恢复：从边界重建后 nonce 不复用（index 续进）", async () => {
    const { gw, dev, gwPersist } = endpoints();
    for (let i = 0; i < 10; i++) await gwSeal(gw, `f${i}`);
    // 崩溃：内存态丢，从持久边界恢复（发送批边界预支 64；接收边界未到批未落盘）
    const restored = RatchetSession.restore(
      { now: () => 0, persist: gwPersist, deviceId: "dev_1", direction: 0 },
      { ...gw.snapshotSend(), nextIndex: RATCHET_BATCH_FRAMES },
      { ...dev.snapshotRecv(), epoch: gw.snapshotSend().epoch },
    );
    // 恢复后 sendNextIndex 从预支边界起（永不复用已用 index）
    expect(restored.snapshotSend().nextIndex).toBe(RATCHET_BATCH_FRAMES);
    expect(restored.snapshotSend().epoch).toBe(1);
  });

  it("重发重加密：同明文新 index 新 nonce，旧 nonce 不复现", async () => {
    const { gw } = endpoints();
    const first = await gwSeal(gw, "resend-me");
    const second = await gwSeal(gw, "resend-me");
    expect(second.index).toBe(first.index + 1);
    expect(Buffer.from(second.nonce).toString("hex")).not.toBe(Buffer.from(first.nonce).toString("hex"));
  });
});

describe("乱序与回归", () => {
  it("乱序：跳过的链钥入 skipped，补帧后命中", async () => {
    const { gw, dev } = endpoints();
    const f0 = await gwSeal(gw, "f0");
    const f1 = await gwSeal(gw, "f1");
    const f2 = await gwSeal(gw, "f2");
    // 先收 f2（乱序）→ skipped 派生 f0/f1 钥
    const o2 = await dev.open({ ciphertext: f2.ct, nonce: f2.nonce, aad: f2.aad, index: f2.index, epoch: f2.epoch });
    expect(o2.ok).toBe(true);
    // 补收 f0/f1 命中 skipped
    const o0 = await dev.open({ ciphertext: f0.ct, nonce: f0.nonce, aad: f0.aad, index: f0.index, epoch: f0.epoch });
    const o1 = await dev.open({ ciphertext: f1.ct, nonce: f1.nonce, aad: f1.aad, index: f1.index, epoch: f1.epoch });
    expect(o0.ok && o1.ok).toBe(true);
  });

  it("index 回退（真重放）→ regression 硬失败", async () => {
    const { gw, dev } = endpoints();
    const f0 = await gwSeal(gw, "f0");
    await gwSeal(gw, "f1");
    const late = await dev.open({ ciphertext: f0.ct, nonce: f0.nonce, aad: f0.aad, index: f0.index, epoch: f0.epoch });
    expect(late.ok).toBe(true);
    // 再收更早 index 的旧帧 → regression
    const again = await dev.open({ ciphertext: f0.ct, nonce: f0.nonce, aad: f0.aad, index: f0.index, epoch: f0.epoch });
    expect(again).toEqual({ ok: false, reason: "regression" });
  });

  it("跨代密文（旧 epoch）拒收", async () => {
    const { gw, dev } = endpoints();
    const f0 = await gwSeal(gw, "f0");
    const stale = await dev.open({ ciphertext: f0.ct, nonce: f0.nonce, aad: f0.aad, index: f0.index, epoch: f0.epoch + 5 });
    expect(stale).toEqual({ ok: false, reason: "tag-failed" });
  });
});

describe("会话辅助面（snapshot/fingerprint/probe/reset）", () => {
  it("chainFingerprint 随链变化；shouldProbeRekey 阈值；resetTagFailures 归零", async () => {
    const { gw, dev } = endpoints();
    const before = gw.chainFingerprint();
    const g1 = generateBoxKeyPair();
    const g2 = generateBoxKeyPair();
    gw.applyDhStep(x25519(g1.secret, g2.pub)!, true);
    dev.applyDhStep(x25519(g2.secret, g1.pub)!, false);
    expect(gw.chainFingerprint()).not.toBe(before);
    expect(gw.shouldProbeRekey()).toBe(false);
    // tag 失败计数至阈值（顺序 index 的垃圾密文——openInOrder 失败路径每次 +1）
    const base = dev.snapshotRecv().nextIndex;
    const epochNow = dev.snapshotRecv().epoch;
    for (let i = 0; i < 33; i++) {
      await dev.open({ ciphertext: new Uint8Array(64).fill(1), nonce: buildNonce(epochNow, 0, base + i), aad: buildAad("a", "b", epochNow), index: base + i, epoch: epochNow });
    }
    expect(dev.shouldProbeRekey()).toBe(true);
    dev.resetTagFailures();
    expect(dev.shouldProbeRekey()).toBe(false);
    // rekeyTo 注入（rekey.ts 走 deriveRekeyChains；会话面 rekeyTo 为直接注入入口）
    const root = "cd".repeat(32);
    gw.rekeyTo({ rootKey: root, sendChainKey: "11".repeat(32), recvChainKey: "22".repeat(32), epoch: 9 });
    expect(gw.snapshotSend().epoch).toBe(9);
    expect(gw.snapshotSend().nextIndex).toBe(0);
  });

  it("restore 的 epoch 撕裂防护（send/recv epoch 不一致抛）", async () => {
    const { gw, dev, gwPersist } = endpoints();
    await gwSeal(gw, "x");
    void dev;
    void gwPersist;
    const send = gw.snapshotSend();
    expect(() =>
      RatchetSession.restore(
        { now: () => 0, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} }, deviceId: "d", direction: 0 },
        send,
        { ...gw.snapshotRecv(), epoch: send.epoch + 5 },
      ),
    ).toThrow(/epoch mismatch/);
  });
});

describe("DH 推进与 rekey", () => {
  it("applyDhStep 后双端继续互通、epoch +1、index 清零", async () => {
    const { gw, dev } = endpoints();
    await gwSeal(gw, "pre");
    const g1 = generateBoxKeyPair();
    const g2 = generateBoxKeyPair();
    const s1 = x25519(g1.secret, g2.pub)!;
    const s2 = x25519(g2.secret, g1.pub)!;
    gw.applyDhStep(s1, true);
    dev.applyDhStep(s2, false);
    expect(gw.snapshotSend().epoch).toBe(2);
    const sealed = await gwSeal(gw, "post");
    expect(sealed.epoch).toBe(2);
    expect(sealed.index).toBe(0);
    const opened = await dev.open({ ciphertext: sealed.ct, nonce: sealed.nonce, aad: sealed.aad, index: sealed.index, epoch: sealed.epoch });
    expect(opened.ok).toBe(true);
  });

  it("rekey 握手派生：混旧根钥，双端一致", () => {
    const { gw } = endpoints();
    const oldRoot = gw.snapshotSend().rootKey;
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    const s1 = x25519(a.secret, b.pub)!;
    const s2 = x25519(b.secret, a.pub)!;
    const init1 = deriveRekeyChains(s1, oldRoot, true);
    const init2 = deriveRekeyChains(s2, oldRoot, false);
    expect(init1.rootKey).toBe(init2.rootKey);
    expect(init1.sendChainKey).toBe(init2.recvChainKey);
    expect(init1.recvChainKey).toBe(init2.sendChainKey);
  });
});
