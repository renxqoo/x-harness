// L3 路由信封（DESIGN §1.1）：relay 只读 to 转发；from 必须与连接认证身份一致（relay
// 侧执法）。无 seq——有序性归 WSS，防重放归 L2。
export interface RouteEnvelope {
  v: number;
  from: string;
  to: string;
  /** base64(AES-GCM 密文) */
  payload: string;
  /** base64(nonce)——WIRE §4 布局；接收方从中反解 epoch/index（重复/乱序三态判据） */
  nonce: string;
}

export function encodeEnvelope(env: RouteEnvelope): string {
  return JSON.stringify(env);
}

/** 解析失败返回 null（垃圾输入降级，不抛） */
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
