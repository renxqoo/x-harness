import { generateBoxKeyPair, signBytes, verifyBytes } from "./crypto.ts";
import { x25519 } from "./crypto.ts";
import { deriveRekeyChains, type RatchetInit } from "./ratchet.ts";

export interface RekeyMessage {
  kind: "rekey-request" | "rekey-accept";
  ephemeralPub: string;
  initiatorSigningPub: string;
  rekeyCounter: number;
  signature: string;
}

export interface RekeyOutcome {
  init: RatchetInit;
  reply: RekeyMessage;
}

function transcript(counter: number, initiatorPub: string, ephemeralPub: string): Uint8Array {
  return new TextEncoder().encode(`rekey|${counter}|${initiatorPub}|${ephemeralPub}`);
}

export function startRekey(spec: { initiatorSigningSecret: string; initiatorSigningPub: string; peerCurrentRatchetPub: string; rekeyCounter: number }): { request: RekeyMessage; ephemeralSecret: string } {
  const ephemeral = generateBoxKeyPair();
  const signature = signBytes(spec.initiatorSigningSecret, transcript(spec.rekeyCounter, spec.initiatorSigningPub, ephemeral.pub));
  return {
    request: { kind: "rekey-request", ephemeralPub: ephemeral.pub, initiatorSigningPub: spec.initiatorSigningPub, rekeyCounter: spec.rekeyCounter, signature },
    ephemeralSecret: ephemeral.secret,
  };
}

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

export function finishRekey(spec: { accept: RekeyMessage; initiatorEphemeralSecret: string; oldRootKey: string; rekeyCounter: number }): RatchetInit | { error: string } {
  if (spec.accept.kind !== "rekey-accept") return { error: "not an accept" };
  if (spec.accept.rekeyCounter !== spec.rekeyCounter) return { error: "counter mismatch" };
  const shared = x25519(spec.initiatorEphemeralSecret, spec.accept.ephemeralPub);
  if (shared === null) return { error: "dh failed" };
  return deriveRekeyChains(shared, spec.oldRootKey, true);
}

export function rekeyDue(messagesSinceDh: number, establishedAt: number, now: number): boolean {
  return messagesSinceDh >= 2000 || now - establishedAt >= 24 * 60 * 60 * 1000;
}
