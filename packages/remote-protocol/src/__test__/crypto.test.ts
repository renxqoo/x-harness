// crypto 契约：往返、指纹、DH 一致性、nonce/AAD 布局、垃圾输入降级
import { describe, expect, it } from "vitest";
import {
  aeadOpen,
  aeadSeal,
  buildAad,
  buildNonce,
  fromSecretSigning,
  generateBoxKeyPair,
  generateSigningKeyPair,
  hkdf,
  signBytes,
  verifyBytes,
  x25519,
  x25519PublicFromSecret,
} from "../crypto.ts";
import { fromHex, toHex } from "../hex.ts";

const enc = new TextEncoder();

describe("签名钥对", () => {
  it("生成/派生往返：公钥 32B、验签成对、篡改失败", () => {
    const kp = generateSigningKeyPair();
    expect(fromHex(kp.pub).length).toBe(32);
    const again = fromSecretSigning(kp.secret);
    expect(again.pub).toBe(kp.pub);
    const sig = signBytes(kp.secret, enc.encode("m1"));
    expect(verifyBytes(kp.pub, enc.encode("m1"), sig)).toBe(true);
    expect(verifyBytes(kp.pub, enc.encode("m2"), sig)).toBe(false);
    // 错误公钥
    expect(verifyBytes(generateSigningKeyPair().pub, enc.encode("m1"), sig)).toBe(false);
  });

  it("垃圾输入：非 32B 种子抛错、坏签名 false 不抛", () => {
    expect(() => fromSecretSigning("abcd")).toThrow();
    expect(verifyBytes("zz", enc.encode("m"), "00")).toBe(false);
    expect(verifyBytes(toHex(new Uint8Array(32)), enc.encode("m"), "00")).toBe(false);
  });
});

describe("X25519", () => {
  it("DH 双向一致；公钥可从私钥重派生", () => {
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    const s1 = x25519(a.secret, b.pub);
    const s2 = x25519(b.secret, a.pub);
    expect(s1).not.toBeNull();
    expect(Buffer.from(s1!).equals(Buffer.from(s2!))).toBe(true);
    expect(x25519PublicFromSecret(a.secret)).toBe(a.pub);
  });

  it("非法输入 null（低阶点/垃圾）不抛", () => {
    expect(x25519(a32(), "00".repeat(32))).toBeNull();
    expect(x25519("ff", a32())).toBeNull();
  });
});

describe("AEAD", () => {
  it("seal/open 往返；AAD 不符 tag 失败", () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = buildNonce(1, 0, 0);
    const aad = buildAad("dev_1", "gw_1", 1);
    const ct = aeadSeal({ key, nonce, plaintext: enc.encode("secret"), aad });
    expect(aeadOpen({ key, nonce, ciphertext: ct, aad })).not.toBeNull();
    expect(aeadOpen({ key, nonce, ciphertext: ct, aad: buildAad("dev_1", "gw_2", 1) })).toBeNull();
    expect(aeadOpen({ key, nonce, ciphertext: ct, aad: buildAad("dev_1", "gw_1", 2) })).toBeNull();
  });

  it("nonce 布局：epoch/dir/index 字节序固定（线格式钉死）；非安全整数拒", () => {
    const n = buildNonce(0x01020304, 1, 0x05060708);
    expect(n.length).toBe(17);
    expect(toHex(n)).toBe("0000000001020304" + "01" + "0000000005060708");
    expect(() => buildNonce(2 ** 53, 1, 1)).toThrow();
  });

  it("空密文/短密文 null 不抛", () => {
    expect(aeadOpen({ key: new Uint8Array(32), nonce: buildNonce(1, 0, 0), ciphertext: new Uint8Array(8), aad: buildAad("a", "b", 1) })).toBeNull();
  });
});

describe("HKDF", () => {
  it("info 域分离：不同 info 不同输出、确定性", () => {
    const ikm = new Uint8Array(32).fill(3);
    const a = hkdf({ ikm, salt: new Uint8Array(32), info: "xh-remote/pairing-channel/v1", length: 32 });
    const b = hkdf({ ikm, salt: new Uint8Array(32), info: "xh-remote/ratchet-root/v1", length: 32 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(hkdf({ ikm, salt: new Uint8Array(32), info: "xh-remote/pairing-channel/v1", length: 32 })))).toBe(true);
  });
});

function a32(): string {
  return toHex(new Uint8Array(32).fill(1));
}
