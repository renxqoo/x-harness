import { createHmac, randomBytes } from "node:crypto";
import { hkdf, HKDF_INFO, x25519, x25519PublicFromSecret } from "./crypto.ts";
import { toHex } from "./hex.ts";

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

export function pakeInitiate(code: string): { state: PakeInitiatorState; message: string } {
  const secret = toHex(randomBytes(32));
  const message = x25519PublicFromSecret(blindScalar(secret, code));
  return { state: { secret, code }, message };
}

export function pakeRespond(code: string, messageA: string): { state: PakeResponderState; message: string; shared: string } {
  const secret = toHex(randomBytes(32));
  const blind = blindScalar(secret, code);
  const message = x25519PublicFromSecret(blind);
  return { state: { secret, code }, message, shared: sharedFrom(blind, messageA, code) };
}

export function pakeFinalize(state: PakeInitiatorState, messageB: string): string {
  return sharedFrom(blindScalar(state.secret, state.code), messageB, state.code);
}

function sharedFrom(ownBlind: string, peerMsg: string, code: string): string {
  const dh = x25519Dh(ownBlind, peerMsg);
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(dh), new TextEncoder().encode(code)]));
  return toHex(hkdf({ ikm: mixed, salt: new Uint8Array(32), info: HKDF_INFO.pake, length: 32 }));
}

function x25519Dh(scalarHex: string, peerPubHex: string): Uint8Array {
  return x25519(scalarHex, peerPubHex) ?? new Uint8Array(32);
}

export function pakeConfirm(sharedHex: string, transcript: string): string {
  return createHmac("sha256", Buffer.from(sharedHex, "hex")).update(transcript).digest("hex");
}

export function pakeConfirmVerify(sharedHex: string, transcript: string, confirm: string): boolean {
  const expect = pakeConfirm(sharedHex, transcript);
  return expect.length === confirm.length && expect === confirm;
}
