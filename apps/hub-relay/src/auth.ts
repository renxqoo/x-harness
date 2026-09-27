// relay token 体系（DESIGN §1.5）：HS256 JWT（类别隔离 device/gateway/pairing）+
// enrollment 注册（gateway 长期钥钉存，冲突告警 fail-closed）。
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type TokenKind = "device" | "gateway" | "pairing";

export interface TokenClaims {
  kind: TokenKind;
  /** device: deviceId；gateway: installationId；pairing: pairingId */
  subject: string;
  installationId?: string;
  scope?: string;
  iat: number;
  exp: number;
  jti: string;
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export function issueToken(secret: string, claims: TokenClaims): string {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const mac = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(new Uint8Array(mac))}`;
}

export function verifyToken(secret: string, token: string, now: number): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expect = createHmac("sha256", secret).update(`${parts[0]!}.${parts[1]!}`).digest();
  const got = Buffer.from(parts[2] ?? "", "base64url");
  if (got.length !== expect.length || !timingSafeEqual(new Uint8Array(got), new Uint8Array(expect))) return null;
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.kind !== "string" || typeof claims.subject !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp <= now) return null;
  return claims;
}

/** 新 jti */
export function newJti(): string {
  return randomUUID();
}

/** enroll 转录签名内容（gateway 长期钥对它签名——relay 用 gatewayKeyPub 验） */
export function enrollTranscript(spec: { installationId: string; gatewayKeyPub: string; nodeId: string; nonce: string }): string {
  return `enroll|${spec.installationId}|${spec.gatewayKeyPub}|${spec.nodeId}|${spec.nonce}`;
}
