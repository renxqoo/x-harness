import { generateBoxKeyPair, hkdf, HKDF_INFO, signBytes, verifyBytes, x25519 } from "./crypto.ts";
import { toHex } from "./hex.ts";
import { pakeFinalize, pakeRespond, pakeConfirm, pakeConfirmVerify } from "./pake.ts";
import { MANUAL_CODE_DIGITS, SAS_DIGITS } from "./limits.ts";
import { createHmac, randomBytes, randomInt } from "node:crypto";

export interface GatewayLongTerm {
  signingSecret: string;
  signingPub: string;
}

export function asGatewayLongTerm(kp: { secret: string; pub: string }): GatewayLongTerm {
  return { signingSecret: kp.secret, signingPub: kp.pub };
}

export interface PairingTranscript {
  pairingId: string;
  gwEph: string;
  devEph: string;
  relayUrl: string;
  scope: string;
}

export function transcriptText(t: PairingTranscript): string {
  return `${t.pairingId}|${t.gwEph}|${t.devEph}|${t.relayUrl}|${t.scope}`;
}

export interface SasSpec {
  channelKey: Uint8Array;
  transcript: PairingTranscript;
  gatewayFingerprint: string;
  deviceFingerprint: string;
}

export function computeSas(spec: SasSpec): string {
  const mac = createHmac("sha256", Buffer.from(spec.channelKey))
    .update(`${transcriptText(spec.transcript)}|${spec.gatewayFingerprint}|${spec.deviceFingerprint}`)
    .digest();
  return (mac.readUInt32BE(0) % 10 ** SAS_DIGITS).toString().padStart(SAS_DIGITS, "0");
}

export function generateManualCode(): string {
  let code = "";
  for (let i = 0; i < MANUAL_CODE_DIGITS; i++) code += randomInt(0, 10).toString();
  return code;
}

export interface QrPayload {
  v: 1;
  relayUrl: string;
  relayKeyFingerprint: string;
  gatewayKeyFingerprint: string;
  pairingId: string;
  gwEphemeralPub: string;
  pairingTicket: string;
}

export function encodeQr(p: QrPayload): string {
  return JSON.stringify(p);
}

export function decodeQr(text: string): QrPayload | null {
  try {
    const raw = JSON.parse(text) as Partial<QrPayload>;
    if (raw.v !== 1) return null;
    if (typeof raw.relayUrl !== "string" || typeof raw.relayKeyFingerprint !== "string") return null;
    if (typeof raw.gatewayKeyFingerprint !== "string" || typeof raw.pairingId !== "string") return null;
    if (typeof raw.gwEphemeralPub !== "string" || typeof raw.pairingTicket !== "string") return null;
    return {
      v: 1,
      relayUrl: raw.relayUrl,
      relayKeyFingerprint: raw.relayKeyFingerprint,
      gatewayKeyFingerprint: raw.gatewayKeyFingerprint,
      pairingId: raw.pairingId,
      gwEphemeralPub: raw.gwEphemeralPub,
      pairingTicket: raw.pairingTicket,
    };
  } catch {
    return null;
  }
}


export interface ChannelEstablished {
  channelKey: Uint8Array;
  transcript: PairingTranscript;
}

export interface EstablishSpec {
  gwLongTerm: GatewayLongTerm;
  pairingId: string;
  gwEphemeralSecret: string;
  gwEphemeralPub: string;
  deviceEphemeralPub: string;
  relayUrl: string;
  scope: string;
}

export function gatewayEstablishChannel(spec: EstablishSpec): ChannelEstablished | null {
  const shared = x25519(spec.gwEphemeralSecret, spec.deviceEphemeralPub);
  if (!shared) return null;
  const channelKey = hkdf({ ikm: shared, salt: new Uint8Array(32), info: HKDF_INFO.pairingChannel, length: 32 });
  const transcript: PairingTranscript = {
    pairingId: spec.pairingId,
    gwEph: spec.gwEphemeralPub,
    devEph: spec.deviceEphemeralPub,
    relayUrl: spec.relayUrl,
    scope: spec.scope,
  };
  return { channelKey, transcript };
}

export function signPairingTranscript(gwLongTerm: GatewayLongTerm, t: PairingTranscript): string {
  return signBytes(gwLongTerm.signingSecret, new TextEncoder().encode(transcriptText(t)));
}

export function verifyPairingTranscript(gatewayPub: string, t: PairingTranscript, sig: string): boolean {
  return verifyBytes(gatewayPub, new TextEncoder().encode(transcriptText(t)), sig);
}


export interface PakeChannel {
  shared: string;
  confirm: string;
}

export function gatewayPakeRespond(code: string, messageA: string, transcript: string): { message: string; channel: PakeChannel } {
  const resp = pakeRespond(code, messageA);
  const shared = resp.shared;
  return {
    message: resp.message,
    channel: { shared, confirm: pakeConfirm(shared, transcript) },
  };
}

export interface DevicePakeSpec {
  code: string;
  secret: string;
  messageB: string;
  gatewayConfirm: string;
  transcript: string;
}

export function devicePakeFinalize(spec: DevicePakeSpec): string | null {
  const shared = pakeFinalize({ secret: spec.secret, code: spec.code }, spec.messageB);
  if (!pakeConfirmVerify(shared, spec.transcript, spec.gatewayConfirm)) return null;
  return shared;
}

export function derivePakeChannelKey(sharedHex: string): Uint8Array {
  return hkdf({ ikm: new Uint8Array(Buffer.from(sharedHex, "hex")), salt: new Uint8Array(32), info: HKDF_INFO.pairingChannel, length: 32 });
}


export interface RatchetSeed {
  sharedSecret: Uint8Array;
  deviceLongTermPub: string;
  gatewaySig: string;
}

export function mixRatchetRoot(channelKey: Uint8Array, deviceLongTermPub: string): Uint8Array {
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(channelKey), Buffer.from(deviceLongTermPub, "utf8")]));
  return new Uint8Array(hkdf({ ikm: mixed, salt: new Uint8Array(32), info: HKDF_INFO.ratchetRoot, length: 32 }));
}

export function newPairingId(): string {
  return `pr_${toHex(randomBytes(8))}`;
}

export function newDeviceEphemeral(): { secret: string; pub: string } {
  return generateBoxKeyPair();
}
