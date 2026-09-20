// OTel 标识铸造：trace_id hex-32 / span_id hex-16（crypto 随机，W3C TraceContext 形状）。
// mintSessionId 是「<UTC时间戳>-<6位随机>」非 hex——不能借用，须自铸并经 otel_sessions 映射。

import { randomBytes } from "node:crypto";

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}
