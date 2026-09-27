// 入站管线（DESIGN §8 管线序 + §1.3）：字节级预解密限流 → 解密（ratchet）→ cmd 桶 →
// scope → 去重 → 路由。供 relay-link 的 onFrame 消费；错误全部降级为计数/丢弃（不崩）。
import { DEVICE_BYTES_PER_SEC, DEVICE_BYTES_BURST, DEVICE_CMDS_BURST, DEVICE_CMDS_PER_SEC, judgeGwCommand, judgeHostCommand, parseFrame, type Frame } from "@x-harness/remote-protocol";

export interface RateBucket {
  bytes: number;
  bytesAt: number;
  cmds: number;
  cmdsAt: number;
}

export function newBucket(): RateBucket {
  // 初始满突发额度（新连接允许瞬时突发，随后按速率回填）
  return { bytes: DEVICE_BYTES_BURST, bytesAt: 0, cmds: DEVICE_CMDS_BURST, cmdsAt: 0 };
}

export type PreflightVerdict =
  | { ok: true }
  | { ok: false; code: "rate-limited" | "bad-envelope" | "bad-frame" | "ratchet-unavailable" };

/** 字节级预解密限流（滑动补充桶：每秒回填 DEVICE_BYTES_PER_SEC，突发 DEVICE_BYTES_BURST） */
export function preflightBytes(bucket: RateBucket, byteLength: number, now: number): boolean {
  const refill = ((now - bucket.bytesAt) / 1000) * DEVICE_BYTES_PER_SEC;
  bucket.bytes = Math.min(DEVICE_BYTES_BURST, bucket.bytes + refill);
  bucket.bytesAt = now;
  if (bucket.bytes < byteLength) return false;
  bucket.bytes -= byteLength;
  return true;
}

/** 命令桶（解密后按 command 帧计数） */
export function preflightCmds(bucket: RateBucket, now: number): boolean {
  const refill = ((now - bucket.cmdsAt) / 1000) * DEVICE_CMDS_PER_SEC;
  bucket.cmds = Math.min(DEVICE_CMDS_BURST, bucket.cmds + refill);
  bucket.cmdsAt = now;
  if (bucket.cmds < 1) return false;
  bucket.cmds -= 1;
  return true;
}

export interface InboundSpec {
  deviceId: string;
  tier: "read" | "interact" | "full";
  bucket: RateBucket;
  decrypt(payloadBase64: string): { plaintext: string | null; tagFailures: number };
  onCommand(frame: Frame, command: string, args: Record<string, unknown>): void;
  onUiResponse(requestId: string, payload: Record<string, unknown>): void;
  onAck(streamId: string, upTo: number): void;
  now(): number;
}

export type InboundOutcome =
  | { kind: "delivered" }
  | { kind: "rate-limited" }
  | { kind: "bad-envelope" }
  | { kind: "bad-frame" }
  | { kind: "ratchet-failed"; tagFailures: number }
  /** scope 越权与 owner-only 对远程设备同面拒绝（§3.2 恒 owner 通道专属） */
  | { kind: "scope-denied"; command: string }
  | { kind: "unknown-command"; command: string };

/** 管线主体：line 是 relay 侧 L3 信封 JSON（from==dev_<id> 已由 relay 执法） */
export function processInboundLine(line: string, spec: InboundSpec): InboundOutcome {
  const now = spec.now();
  if (!preflightBytes(spec.bucket, Buffer.byteLength(line), now)) return { kind: "rate-limited" };
  let envelope: { payload?: unknown } | null = null;
  try {
    envelope = JSON.parse(line) as { payload?: unknown };
  } catch {
    return { kind: "bad-envelope" };
  }
  if (envelope === null || typeof envelope.payload !== "string") return { kind: "bad-envelope" };
  const decrypted = spec.decrypt(envelope.payload);
  if (decrypted.plaintext === null) return { kind: "ratchet-failed", tagFailures: decrypted.tagFailures };
  const frame = parseFrame(decrypted.plaintext);
  if (frame === null) return { kind: "bad-frame" };
  if (frame.kind === "ack") {
    const body = frame.body as { acks?: Array<{ streamId: string; upTo: number }> };
    for (const ack of body.acks ?? []) spec.onAck(ack.streamId, ack.upTo);
    return { kind: "delivered" };
  }
  if (frame.kind === "ui_response") {
    if (spec.tier === "read") return { kind: "scope-denied", command: "ui_response" };
    const body = frame.body as { requestId?: string; payload?: Record<string, unknown> };
    if (typeof body.requestId === "string") spec.onUiResponse(body.requestId, body.payload ?? {});
    return { kind: "delivered" };
  }
  if (frame.kind !== "command") return { kind: "delivered" };
  if (!preflightCmds(spec.bucket, now)) return { kind: "rate-limited" };
  const body = frame.body as { command?: string; id?: string; args?: Record<string, unknown> };
  const command = typeof body.command === "string" ? body.command : "";
  if (command.startsWith("gw/")) {
    if (judgeGwCommand(command, spec.tier) === "allow" && command === "gw/status") {
      spec.onCommand(frame, command, {});
      return { kind: "delivered" };
    }
    return { kind: "scope-denied", command };
  }
  const verdict = judgeHostCommand(command, spec.tier);
  if (verdict === "scope-denied" || verdict === "owner-only") return { kind: "scope-denied", command };
  if (verdict !== "allow") return { kind: "unknown-command", command };
  spec.onCommand(frame, command, body.args ?? {});
  return { kind: "delivered" };
}
