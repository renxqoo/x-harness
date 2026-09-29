import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { fromHex, toHex } from "./hex.ts";

export const CRYPTO_SUITE = "x25519-ed25519-aes256gcm-hkdf-sha256-v1";

export const HKDF_INFO = {
  pairingChannel: "xh-remote/pairing-channel/v1",
  ratchetRoot: "xh-remote/ratchet-root/v1",
  messageKey: "xh-remote/message-key/v1",
  rekeyRoot: "xh-remote/rekey-root/v1",
  sas: "xh-remote/sas/v1",
  relayToken: "xh-remote/relay-token/v1",
  pake: "xh-remote/pake/v1",
} as const;

export interface KeyPairHex {
  secret: string;
  pub: string;
}


function wrapPkcs8(raw: Uint8Array, oid: "ed25519" | "x25519"): Buffer {
  const prefix = oid === "ed25519" ? "302e020100300506032b657004220420" : "302e020100300506032b656e04220420";
  return Buffer.concat([Buffer.from(prefix, "hex"), Buffer.from(raw)]);
}

function wrapSpki(raw: Uint8Array, oid: "ed25519" | "x25519"): Buffer {
  const prefix = oid === "ed25519" ? "302a300506032b6570032100" : "302a300506032b656e032100";
  return Buffer.concat([Buffer.from(prefix, "hex"), Buffer.from(raw)]);
}

function expectRaw32(hex: string): Uint8Array {
  const raw = fromHex(hex);
  if (raw.length !== 32) {
    throw new Error("crypto: raw key must be 32 bytes");
  }
  return raw;
}


export function generateSigningKeyPair(): KeyPairHex {
  return fromSecretSigning(toHex(randomBytes(32)));
}

export function fromSecretSigning(seedHex: string): KeyPairHex {
  const seed = expectRaw32(seedHex);
  const priv = createPrivateKey({ key: wrapPkcs8(seed, "ed25519"), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return { secret: seedHex, pub: toHex(new Uint8Array(spki.subarray(spki.length - 32))) };
}

export function generateBoxKeyPair(): KeyPairHex {
  const secret = randomBytes(32);
  return { secret: toHex(secret), pub: x25519PublicFromSecret(toHex(secret)) };
}

export function x25519PublicFromSecret(secretHex: string): string {
  const raw = expectRaw32(secretHex);
  const priv = createPrivateKey({ key: wrapPkcs8(raw, "x25519"), format: "der", type: "pkcs8" });
  const der = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return toHex(new Uint8Array(der.subarray(der.length - 32)));
}


export function x25519(secretHex: string, peerPublicHex: string): Uint8Array | null {
  try {
    const privRaw = expectRaw32(secretHex);
    const pubRaw = expectRaw32(peerPublicHex);
    const shared = diffieHellman({
      privateKey: createPrivateKey({ key: wrapPkcs8(privRaw, "x25519"), format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: wrapSpki(pubRaw, "x25519"), format: "der", type: "spki" }),
    });
    return new Uint8Array(shared);
  } catch {
    return null;
  }
}


export function signBytes(seedHex: string, data: Uint8Array): string {
  const seed = expectRaw32(seedHex);
  const sig = edSign(null, Buffer.from(data), createPrivateKey({ key: wrapPkcs8(seed, "ed25519"), format: "der", type: "pkcs8" }));
  return toHex(new Uint8Array(sig));
}

export function verifyBytes(pubHex: string, data: Uint8Array, sigHex: string): boolean {
  try {
    const pubRaw = expectRaw32(pubHex);
    const sig = fromHex(sigHex);
    if (sig.length !== 64) return false;
    return edVerify(
      null,
      Buffer.from(data),
      createPublicKey({ key: wrapSpki(pubRaw, "ed25519"), format: "der", type: "spki" }),
      Buffer.from(sig),
    );
  } catch {
    return false;
  }
}


export interface HkdfSpec {
  ikm: Uint8Array;
  salt: Uint8Array;
  info: string;
  length: number;
}

export function hkdf(spec: HkdfSpec): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", Buffer.from(spec.ikm), Buffer.from(spec.salt), Buffer.from(spec.info, "utf8"), spec.length));
}

export interface AeadSpec {
  key: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  aad: Uint8Array;
}

export function aeadSeal(spec: AeadSpec): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(spec.key), Buffer.from(spec.nonce), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(spec.aad));
  const ct = Buffer.concat([cipher.update(Buffer.from(spec.plaintext)), cipher.final()]);
  return new Uint8Array(Buffer.concat([ct, cipher.getAuthTag()]));
}

export interface AeadOpenSpec {
  key: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  aad: Uint8Array;
}

export function aeadOpen(spec: AeadOpenSpec): Uint8Array | null {
  const { ciphertext } = spec;
  if (ciphertext.length < 16) return null;
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(spec.key), Buffer.from(spec.nonce), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(spec.aad));
    decipher.setAuthTag(Buffer.from(tag));
    const pt = Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()]);
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}


export function buildNonce(epoch: number, direction: 0 | 1, index: number): Uint8Array {
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(index) || epoch < 0 || index < 0) {
    throw new Error("crypto: nonce epoch/index must be safe integers");
  }
  const nonce = new Uint8Array(17);
  const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  dv.setBigUint64(0, BigInt(epoch), false);
  nonce[8] = direction;
  dv.setBigUint64(9, BigInt(index), false);
  return nonce;
}

export function parseNonce(nonce: Uint8Array): { epoch: number; index: number; direction: number } | null {
  if (nonce.length !== 17) return null;
  const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const epoch = dv.getBigUint64(0, false);
  const index = dv.getBigUint64(9, false);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER) || index > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { epoch: Number(epoch), index: Number(index), direction: nonce[8] ?? 0 };
}

export function buildAad(from: string, to: string, epoch: number): Uint8Array {
  return new Uint8Array(Buffer.from(`v1|${from}|${to}|${epoch}`, "utf8"));
}
