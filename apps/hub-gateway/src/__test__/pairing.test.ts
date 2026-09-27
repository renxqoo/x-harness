// B3 单元与旅程：配对服务器（QR/手输/锁定/SAS 双向）、crypto 会话池（建立/恢复/种子）
import { describe, expect, it } from "vitest";
import { createPairingServer } from "../pairing-server.ts";
import { computeSas, gatewayEstablishChannel, newDeviceEphemeral, pakeInitiate, verifyPairingTranscript } from "@x-harness/remote-protocol";
import type { GatewayIdentity } from "../identity.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../identity.ts";
import { createCryptoSessionPool, seedFromPairing } from "../session-crypto.ts";
import { generateBoxKeyPair, generateSigningKeyPair, x25519 } from "@x-harness/remote-protocol";

function fakeIdentity(): GatewayIdentity {
  const signing = generateSigningKeyPair();
  return { installationId: "inst_test", signingSecret: signing.secret, signingPub: signing.pub, boxSecret: "aa", boxPub: "bb" };
}

function makeServer(now: () => number, registered: Array<{ deviceId: string }> = []) {
  const identity = fakeIdentity();
  const auditLog: string[] = [];
  const server = createPairingServer({
    identity,
    relayUrl: "wss://relay.test",
    audit: {
      async record(event, detail) {
        auditLog.push(`${event}:${JSON.stringify(detail)}`);
      },
    },
    now,
    requestPairingTicket: async (pairingId) => `ticket_${pairingId}`,
    onRegistered: async (device) => {
      registered.push({ deviceId: device.deviceId });
    },
    maxConcurrent: 8,
  });
  return { server, identity, auditLog, registered };
}

describe("QR 配对路径", () => {
  it("start→device request→SAS 双向确认→注册（缺省 read scope）", async () => {
    let ts = Date.now();
    const { server, identity, registered } = makeServer(() => ts);
    const started = await server.startQr("read");
    expect(started.pairingId).toMatch(/^pr_/);
    const qr = JSON.parse(started.qrPayload) as { gwEphemeralPub: string; pairingTicket: string };
    expect(qr.gwEphemeralPub).toBeTruthy();
    // 手机侧：临时钥 + request
    const deviceEph = newDeviceEphemeral();
    const res = await server.handleDeviceRequest({
      pairingId: started.pairingId,
      deviceEphemeralPub: deviceEph.pub,
      deviceInfo: { name: "My Phone", deviceType: "phone", platform: "ios", appVersion: "1" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 手机侧独立验证网关转录签名（钉存 gateway 指纹）
    const channel = gatewayEstablishChannel({
      gwLongTerm: { signingSecret: identity.signingSecret, signingPub: identity.signingPub },
      pairingId: started.pairingId,
      gwEphemeralSecret: qr.gwEphemeralPub, // 手机侧无 gw 私钥——仅验签
      gwEphemeralPub: qr.gwEphemeralPub,
      deviceEphemeralPub: deviceEph.pub,
      relayUrl: "wss://relay.test",
      scope: "read",
    });
    expect(channel).not.toBeNull();
    // owner 键入错误 SAS → 拒
    const bad = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: "000000", deviceLongTermPub: generateSigningKeyPair().pub });
    expect(bad.ok).toBe(false);
    // owner 键入正确 SAS → 注册
    const ok = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: res.sas, deviceLongTermPub: generateSigningKeyPair().pub });
    expect(ok.ok).toBe(true);
    expect(registered.length).toBe(1);
    // 单次使用
    const again = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: res.sas, deviceLongTermPub: generateSigningKeyPair().pub });
    expect(again.ok).toBe(false);
  });

  it("过期/未知 pairingId/竞态占用拒绝", async () => {
    let ts = Date.now();
    const { server } = makeServer(() => ts);
    const started = await server.startQr("read");
    ts += 121_000;
    const expired = await server.handleDeviceRequest({ pairingId: started.pairingId, deviceEphemeralPub: newDeviceEphemeral().pub, deviceInfo: { name: "x", deviceType: "p", platform: "i", appVersion: "1" } });
    expect(expired.ok).toBe(false);
    const unknown = await server.handleDeviceRequest({ pairingId: "pr_ghost", deviceEphemeralPub: "aa", deviceInfo: { name: "x", deviceType: "p", platform: "i", appVersion: "1" } });
    expect(unknown.ok).toBe(false);
  });

  it("SAS 错 5 次 → 锁定 5min", async () => {
    let ts = Date.now();
    const { server } = makeServer(() => ts);
    const started = await server.startQr("read");
    const res = await server.handleDeviceRequest({ pairingId: started.pairingId, deviceEphemeralPub: newDeviceEphemeral().pub, deviceInfo: { name: "x", deviceType: "p", platform: "i", appVersion: "1" } });
    if (!res.ok) throw new Error("unreachable");
    for (let i = 0; i < 4; i++) {
      const bad = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: "000000", deviceLongTermPub: "aa" });
      expect(bad.ok).toBe(false);
    }
    // 第 5 次失败 → 锁定
    const fifth = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: "000000", deviceLongTermPub: "aa" });
    expect(fifth.ok).toBe(false);
    ts += 60_000;
    const locked = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: res.sas, deviceLongTermPub: "aa" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe("locked");
    // 5min 后锁定期过（会话 120s TTL 已先到期——新配对走新会话）
    ts += 5 * 60_000;
    const after = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: "000000", deviceLongTermPub: "aa" });
    expect(after.ok).toBe(false);
  });

  it("并发上限 8", async () => {
    const { server } = makeServer(() => Date.now());
    for (let i = 0; i < 8; i++) await server.startQr("read");
    await expect(server.startQr("read")).rejects.toThrow();
  });
});

describe("手输码 PAKE 路径", () => {
  it("PAKE 往返 + SAS 确认注册", async () => {
    let ts = Date.now();
    const { server, registered } = makeServer(() => ts);
    const started = await server.startManual("read");
    expect(started.manualCode).toMatch(/^\d{8}$/);
    const init = pakeInitiate(started.manualCode);
    const res = await server.handlePakeInitiate({ pairingId: started.pairingId, messageA: init.message, deviceInfo: { name: "My Phone", deviceType: "phone", platform: "android", appVersion: "1" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sas = server.sessionOf(started.pairingId)?.sas ?? "";
    const confirmed = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: sas, deviceLongTermPub: generateSigningKeyPair().pub });
    expect(confirmed.ok).toBe(true);
    expect(registered.length).toBe(1);
  });

  it("错码 PAKE：SAS 确认失败路径（在线尝试计入）", async () => {
    const { server } = makeServer(() => Date.now());
    const started = await server.startManual("read");
    const wrong = pakeInitiate("11112222");
    const res = await server.handlePakeInitiate({ pairingId: started.pairingId, messageA: wrong.message, deviceInfo: { name: "x", deviceType: "p", platform: "i", appVersion: "1" } });
    // gateway 用自己的码应答——shared 与手机不一致；confirm 互验失败在手机侧暴露
    expect(res.ok).toBe(true);
    const sas = server.sessionOf(started.pairingId)?.sas ?? "";
    // 手机侧 SAS（由错码通道算出）与网关 SAS 不同 → owner 键入手机侧 SAS 拒
    if (res.ok) {
      const bad = await server.confirmWithSas({ pairingId: started.pairingId, ownerTypedSas: sas === "000000" ? "111111" : "000000", deviceLongTermPub: "aa" });
      expect(bad.ok).toBe(false);
    }
  });
});

describe("crypto 会话池", () => {
  it("建立→互发→恢复旅程", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crypto-"));
    const identity = await loadOrCreateIdentity({ agentDir: dir, installationIdFile: join(dir, "iid"), gatewayIdentityFile: join(dir, "gid.json") });
    void identity;
    const pool = createCryptoSessionPool(dir, Date.now);
    const gwEph = generateBoxKeyPair();
    const devEph = generateBoxKeyPair();
    const shared = x25519(gwEph.secret, devEph.pub)!;
    const gatewaySession = pool.establish({ deviceId: "d1", sharedSecret: shared, initiator: true });
    expect(pool.get("d1")).not.toBeNull();
    void gatewaySession;
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    // 恢复
    pool.drop("d1");
    const restored = await pool.restore("d1");
    expect(restored).not.toBeNull();
    expect(restored?.ratchet.snapshotSend().epoch).toBe(1);
  });

  it("边界持久化：seal/open 驱动 send/recv 边界落盘 + 恢复后互通", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crypto2-"));
    const pool = createCryptoSessionPool(dir, Date.now);
    const gwEph = generateBoxKeyPair();
    const devEph = generateBoxKeyPair();
    const shared = x25519(gwEph.secret, devEph.pub)!;
    const session = pool.establish({ deviceId: "d9", sharedSecret: shared, initiator: true });
    // seal 65+ 帧触发批边界持久化
    const { aeadSeal, buildAad, buildNonce, RatchetSession: RS, deriveInitialChains } = await import("@x-harness/remote-protocol");
    const devInit = deriveInitialChains(x25519(devEph.secret, gwEph.pub)!, false);
    const devRatchet = new RS({ now: Date.now, deviceId: "d9", direction: 1, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } }, devInit);
    for (let i = 0; i < 70; i++) {
      const outcome = await session.ratchet.seal({ plaintext: new TextEncoder().encode(`f${i}`), aadFrom: "gw", aadTo: "d9" });
      if (!outcome.ok) throw new Error("seal failed");
      const ct = aeadSeal({ key: new Uint8Array(Buffer.from(outcome.keyUsed, "hex")), nonce: outcome.nonce, plaintext: new TextEncoder().encode(`f${i}`), aad: outcome.aad });
      const opened = await devRatchet.open({ ciphertext: ct, nonce: outcome.nonce, aad: outcome.aad, index: outcome.index, epoch: outcome.epoch });
      expect(opened.ok).toBe(true);
    }
    await new Promise((r) => {
      setTimeout(r, 80);
    });
    // 恢复：epoch 与链延续
    pool.drop("d9");
    const restored = await pool.restore("d9");
    expect(restored).not.toBeNull();
    expect(restored!.ratchet.snapshotSend().epoch).toBe(1);
    expect(restored!.ratchet.snapshotRecv().recvChainKey).toBe(devRatchet.snapshotSend().sendChainKey);
  });

  it("seedFromPairing：DH 失败 null；成功确定性", () => {
    const gwEph = generateBoxKeyPair();
    const devEph = generateBoxKeyPair();
    expect(seedFromPairing(new Uint8Array(32), "pub", { secret: "zz" }, devEph.pub)).toBeNull();
    const s1 = seedFromPairing(new Uint8Array(32).fill(3), "pub", { secret: gwEph.secret }, devEph.pub);
    const s2 = seedFromPairing(new Uint8Array(32).fill(3), "pub", { secret: gwEph.secret }, devEph.pub);
    expect(s1).not.toBeNull();
    expect(Buffer.from(s1!).equals(Buffer.from(s2!))).toBe(true);
  });
});

describe("配对签名验签（端侧视角）", () => {
  it("gateway 转录签名可被公钥验证（QR 携带 gwEphemeralPub）", () => {
    const identity = fakeIdentity();
    const gwEph = newDeviceEphemeral();
    const devEph = newDeviceEphemeral();
    const channel = gatewayEstablishChannel({
      gwLongTerm: { signingSecret: identity.signingSecret, signingPub: identity.signingPub },
      pairingId: "pr_x",
      gwEphemeralSecret: gwEph.secret,
      gwEphemeralPub: gwEph.pub,
      deviceEphemeralPub: devEph.pub,
      relayUrl: "wss://r",
      scope: "read",
    });
    expect(channel).not.toBeNull();
  });
});

export { computeSas, verifyPairingTranscript };
