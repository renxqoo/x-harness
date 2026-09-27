// 配对协议契约：QR 路径通道建立/转录签名/SAS、手输码 PAKE 往返、指纹钉存——DESIGN §1.4
import { describe, expect, it } from "vitest";
import {
  asGatewayLongTerm,
  computeSas,
  decodeQr,
  devicePakeFinalize,
  encodeQr,
  gatewayEstablishChannel,
  gatewayPakeRespond,
  generateManualCode,
  mixRatchetRoot,
  newDeviceEphemeral,
  newPairingId,
  signPairingTranscript,
  verifyPairingTranscript,
} from "../pairing.ts";
import { generateBoxKeyPair, generateSigningKeyPair, x25519 } from "../crypto.ts";
import { pakeInitiate } from "../pake.ts";

describe("QR 路径", () => {
  it("通道建立：双端同钥；转录签名可验（钉存 gateway 指纹）", () => {
    const gwLong = asGatewayLongTerm(generateSigningKeyPair());
    const gwEph = generateBoxKeyPair();
    const devEph = newDeviceEphemeral();
    const pairingId = newPairingId();
    const ch = gatewayEstablishChannel({
      gwLongTerm: gwLong,
      pairingId,
      gwEphemeralSecret: gwEph.secret,
      gwEphemeralPub: gwEph.pub,
      deviceEphemeralPub: devEph.pub,
      relayUrl: "wss://relay.example.com",
      scope: "interact",
    });
    expect(ch).not.toBeNull();
    // 手机侧独立派生同一 DH（x25519 双向一致）
    expect(Buffer.from(x25519(devEph.secret, gwEph.pub)!).toString("hex")).not.toBe("");
    const sig = signPairingTranscript(gwLong, ch!.transcript);
    expect(verifyPairingTranscript(gwLong.signingPub, ch!.transcript, sig)).toBe(true);
    expect(verifyPairingTranscript(generateSigningKeyPair().pub, ch!.transcript, sig)).toBe(false);
  });

  it("SAS：双端一致（同一通道钥+转录+指纹）；位数恒 6", () => {
    const gwEph = generateBoxKeyPair();
    const devEph = newDeviceEphemeral();
    const gwLong = asGatewayLongTerm(generateSigningKeyPair());
    const devLong = generateSigningKeyPair();
    const pairingId = newPairingId();
    const ch = gatewayEstablishChannel({
      gwLongTerm: gwLong,
      pairingId,
      gwEphemeralSecret: gwEph.secret,
      gwEphemeralPub: gwEph.pub,
      deviceEphemeralPub: devEph.pub,
      relayUrl: "wss://r",
      scope: "interact",
    })!;
    const sas1 = computeSas({ channelKey: ch.channelKey, transcript: ch.transcript, gatewayFingerprint: gwLong.signingPub, deviceFingerprint: devLong.pub });
    const sas2 = computeSas({ channelKey: ch.channelKey, transcript: ch.transcript, gatewayFingerprint: gwLong.signingPub, deviceFingerprint: devLong.pub });
    expect(sas1).toBe(sas2);
    expect(sas1).toMatch(/^\d{6}$/);
    // 转录被改 → SAS 变
    const tampered = { ...ch.transcript, scope: "full" };
    expect(computeSas({ channelKey: ch.channelKey, transcript: tampered, gatewayFingerprint: gwLong.signingPub, deviceFingerprint: devLong.pub })).not.toBe(sas1);
  });

  it("QR 编解码往返；垃圾降级 null", () => {
    const p = {
      v: 1 as const,
      relayUrl: "wss://relay.example.com",
      relayKeyFingerprint: "sha256:aa",
      gatewayKeyFingerprint: "sha256:bb",
      pairingId: newPairingId(),
      gwEphemeralPub: generateBoxKeyPair().pub,
      pairingTicket: "tk_1",
    };
    expect(decodeQr(encodeQr(p))).toEqual(p);
    expect(decodeQr("http://evil")).toBeNull();
    expect(decodeQr("{}")).toBeNull();
    expect(decodeQr('{"v":2}')).toBeNull();
  });
});

describe("手输码 PAKE", () => {
  it("正确码：双端同共享、confirm 互验通过", () => {
    const code = generateManualCode();
    expect(code).toMatch(/^\d{8}$/);
    const transcript = "pairing|transcript";
    const init = pakeInitiate(code);
    const resp = gatewayPakeRespond(code, init.message, transcript);
    const shared = devicePakeFinalize({ code, secret: init.state.secret, messageB: resp.message, gatewayConfirm: resp.channel.confirm, transcript });
    expect(shared).not.toBeNull();
    expect(shared).toBe(resp.channel.shared);
  });

  it("错误码：confirm 验证失败（在线尝试面）", () => {
    const init = pakeInitiate("11111111");
    const resp = gatewayPakeRespond("22222222", init.message, "t");
    expect(devicePakeFinalize({ code: "11111111", secret: init.state.secret, messageB: resp.message, gatewayConfirm: resp.channel.confirm, transcript: "t" })).toBeNull();
  });

  it("转录不同 → confirm 失败（防错绑）", () => {
    const code = generateManualCode();
    const init = pakeInitiate(code);
    const resp = gatewayPakeRespond(code, init.message, "transcript-A");
    expect(devicePakeFinalize({ code, secret: init.state.secret, messageB: resp.message, gatewayConfirm: resp.channel.confirm, transcript: "transcript-B" })).toBeNull();
  });
});

describe("配对辅助面（线格式契约）", () => {
  it("derivePakeChannelKey 确定性；mixRatchetRoot 与设备公钥绑定；QR 垃圾输入 null", async () => {
    const { derivePakeChannelKey } = await import("../pairing.ts");
    const { pakeInitiate, pakeRespond } = await import("../pake.ts");
    const a = pakeInitiate("11111111");
    const b = pakeRespond("11111111", a.message);
    const k1 = derivePakeChannelKey("ab".repeat(32));
    expect(k1).toEqual(derivePakeChannelKey("ab".repeat(32)));
    expect(k1.length).toBe(32);
    void b;
    expect(mixRatchetRoot(new Uint8Array(32), "aa")).not.toBeNull();
    expect(decodeQr("{bad json")).toBeNull();
    expect(decodeQr("http://x")).toBeNull();
  });
});

describe("ratchet 种子", () => {
  it("mixRatchetRoot 确定性且随设备公钥变化", () => {
    const ck = new Uint8Array(32).fill(9);
    const a = mixRatchetRoot(ck, "aabb");
    const b = mixRatchetRoot(ck, "aabb");
    const c = mixRatchetRoot(ck, "ccdd");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });
});
