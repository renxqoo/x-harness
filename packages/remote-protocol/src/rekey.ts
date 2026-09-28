// 强制 rekey 握手（DESIGN §1.3）：会话每 2000 消息或 24h 强制一次 DH 推进——ratchet 态
// 失窃的暴露窗有界（S4）。发起方生成新临时钥 + 长期钥签名（rekeyCounter 防重放），
// 应答方验签后以同构消息回执；双端 deriveRekeyChains 重建（epoch++、index 清零）。
import { generateBoxKeyPair, signBytes, verifyBytes } from "./crypto.ts";
import { x25519 } from "./crypto.ts";
import { deriveRekeyChains, type RatchetInit } from "./ratchet.ts";

export interface RekeyMessage {
  kind: "rekey-request" | "rekey-accept";
  /** 发起方新临时公钥（request）/ 应答方新临时公钥（accept） */
  ephemeralPub: string;
  /** 发起方（gateway）长期签名公钥（验签锚） */
  initiatorSigningPub: string;
  rekeyCounter: number;
  signature: string;
}

export interface RekeyOutcome {
  init: RatchetInit;
  reply: RekeyMessage;
}

/** 转录：rekey|counter|initiatorPub|ownEphemeral */
function transcript(counter: number, initiatorPub: string, ephemeralPub: string): Uint8Array {
  return new TextEncoder().encode(`rekey|${counter}|${initiatorPub}|${ephemeralPub}`);
}

/** 发起侧（gateway）：生成请求消息 + 预备新链（对端 accept 后启用） */
export function startRekey(spec: { initiatorSigningSecret: string; initiatorSigningPub: string; peerCurrentRatchetPub: string; rekeyCounter: number }): { request: RekeyMessage; ephemeralSecret: string } {
  const ephemeral = generateBoxKeyPair();
  const signature = signBytes(spec.initiatorSigningSecret, transcript(spec.rekeyCounter, spec.initiatorSigningPub, ephemeral.pub));
  return {
    request: { kind: "rekey-request", ephemeralPub: ephemeral.pub, initiatorSigningPub: spec.initiatorSigningPub, rekeyCounter: spec.rekeyCounter, signature },
    ephemeralSecret: ephemeral.secret,
  };
}

/** 应答侧（设备）验证请求并生成 accept + 新链 */
export function acceptRekey(spec: { request: RekeyMessage; responderEphemeralSecret: string; responderEphemeralPub: string; initiatorSigningPub: string; oldRootKey: string }): RekeyOutcome | { error: string } {
  if (spec.request.kind !== "rekey-request") return { error: "not a request" };
  if (spec.request.initiatorSigningPub !== spec.initiatorSigningPub) return { error: "signer mismatch" };
  if (!verifyBytes(spec.initiatorSigningPub, transcript(spec.request.rekeyCounter, spec.initiatorSigningPub, spec.request.ephemeralPub), spec.request.signature)) {
    return { error: "bad signature" };
  }
  const shared = x25519(spec.responderEphemeralSecret, spec.request.ephemeralPub);
  if (shared === null) return { error: "dh failed" };
  const init = deriveRekeyChains(shared, spec.oldRootKey, false);
  return {
    init,
    reply: { kind: "rekey-accept", ephemeralPub: spec.responderEphemeralPub, initiatorSigningPub: spec.initiatorSigningPub, rekeyCounter: spec.request.rekeyCounter, signature: "" },
  };
}

/** 发起侧收 accept：验对端临时钥参与 DH → 新链（与应答侧一致） */
export function finishRekey(spec: { accept: RekeyMessage; initiatorEphemeralSecret: string; oldRootKey: string; rekeyCounter: number }): RatchetInit | { error: string } {
  if (spec.accept.kind !== "rekey-accept") return { error: "not an accept" };
  if (spec.accept.rekeyCounter !== spec.rekeyCounter) return { error: "counter mismatch" };
  const shared = x25519(spec.initiatorEphemeralSecret, spec.accept.ephemeralPub);
  if (shared === null) return { error: "dh failed" };
  return deriveRekeyChains(shared, spec.oldRootKey, true);
}

/** 会话的 rekey 到期判定（消息数/时间窗） */
export function rekeyDue(messagesSinceDh: number, establishedAt: number, now: number): boolean {
  return messagesSinceDh >= 2000 || now - establishedAt >= 24 * 60 * 60 * 1000;
}
