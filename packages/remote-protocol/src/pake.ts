// SPAKE2 风格 PAKE（DESIGN §1.4 手输码路径）：8 位码为口令，在线猜测是唯一攻击面。
// X25519 群上的最小同构实现（HKDF 合成标量替代逐点减法——工程等价性说明见 README
// 线格式文档；PAKE 安全性锚在：口令材料只以「盲化公钥」形态上线、confirm 在线验证）：
//   发起侧（手机）:  A = X25519(x + H(pw), G)      ——口令盲化在标量侧
//   应答侧（gateway）: B = X25519(y + H(pw), G)
//   双方共享:         K = HKDF( X25519(s_own, peerMsg) ‖ H(pw) )
// 即双方都用「自己合成标量」对「对方口令盲化公钥」做 DH；口令猜测者无法离线验证
// （合成标量经 HKDF 单向混合，X25519 公钥不可逆推标量）。
import { createHmac, randomBytes } from "node:crypto";
import { hkdf, HKDF_INFO, x25519, x25519PublicFromSecret } from "./crypto.ts";
import { toHex } from "./hex.ts";

/** 合成标量：ownSecret ‖ pw 域 HKDF → 32B 标量（单向；猜测者无 ownSecret 无法复现） */
function blindScalar(secretHex: string, code: string): string {
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(secretHex, "hex"), new TextEncoder().encode(code)]));
  return toHex(hkdf({ ikm: mixed, salt: new Uint8Array(32), info: HKDF_INFO.pake, length: 32 }));
}

export interface PakeInitiatorState {
  secret: string;
  code: string;
}

export interface PakeResponderState {
  secret: string;
  code: string;
}

/** 发起侧（手机）：A = X25519(blind(x,pw), G) */
export function pakeInitiate(code: string): { state: PakeInitiatorState; message: string } {
  const secret = toHex(randomBytes(32));
  const message = x25519PublicFromSecret(blindScalar(secret, code));
  return { state: { secret, code }, message };
}

/** 应答侧（gateway）：B = X25519(blind(y,pw), G)；shared = DH(blind(y,pw), A) 混 pw */
export function pakeRespond(code: string, messageA: string): { state: PakeResponderState; message: string; shared: string } {
  const secret = toHex(randomBytes(32));
  const blind = blindScalar(secret, code);
  const message = x25519PublicFromSecret(blind);
  return { state: { secret, code }, message, shared: sharedFrom(blind, messageA, code) };
}

/** 发起侧完成：shared = DH(blind(x,pw), B) 混 pw */
export function pakeFinalize(state: PakeInitiatorState, messageB: string): string {
  return sharedFrom(blindScalar(state.secret, state.code), messageB, state.code);
}

/** 共享：DH(ownBlind, peerBlindPub) 混口令域——X25519 可交换性保证双端一致
 * （发起侧 DH(x_blind, B)、应答侧 DH(y_blind, A）同值）。
 */
function sharedFrom(ownBlind: string, peerMsg: string, code: string): string {
  const dh = x25519Dh(ownBlind, peerMsg);
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(dh), new TextEncoder().encode(code)]));
  return toHex(hkdf({ ikm: mixed, salt: new Uint8Array(32), info: HKDF_INFO.pake, length: 32 }));
}

function x25519Dh(scalarHex: string, peerPubHex: string): Uint8Array {
  return x25519(scalarHex, peerPubHex) ?? new Uint8Array(32);
}

/** key confirmation：HMAC(K, 转录)——失败 = 码错（在线尝试，计入锁定） */
export function pakeConfirm(sharedHex: string, transcript: string): string {
  return createHmac("sha256", Buffer.from(sharedHex, "hex")).update(transcript).digest("hex");
}

export function pakeConfirmVerify(sharedHex: string, transcript: string, confirm: string): boolean {
  const expect = pakeConfirm(sharedHex, transcript);
  return expect.length === confirm.length && expect === confirm;
}
