export interface RouteEnvelope {
  v: number;
  from: string;
  to: string;
  payload: string;
  nonce: string;
}

export function encodeEnvelope(env: RouteEnvelope): string {
  return JSON.stringify(env);
}

export function decodeEnvelope(line: string): RouteEnvelope | null {
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<RouteEnvelope>;
  if (env.v !== 1 || typeof env.from !== "string" || typeof env.to !== "string" || typeof env.payload !== "string") {
    return null;
  }
  if (env.from.length === 0 || env.to.length === 0 || env.payload.length === 0) return null;
  if (typeof env.nonce !== "string" || env.nonce.length === 0) return null;
  return { v: env.v, from: env.from, to: env.to, payload: env.payload, nonce: env.nonce };
}
