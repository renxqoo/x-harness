import type { HubErrorShape } from "../shared/errors.ts";
import { responseLine } from "../shared/frame-classify.ts";

export interface SettledEvent {
  sendId: string;
  ok: boolean;
  reason?: string;
}

export interface BashExecutionUpdate {
  id: string;
  delta: string;
  truncated?: boolean;
}

export function responseFrame(fields: {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: HubErrorShape;
}): string {
  return responseLine(fields);
}

export function eventFrame(fields: {
  threadId: string;
  name: string;
  payload: unknown;
  agentName?: string;
}): string {
  const agent = fields.agentName !== undefined ? `,"agentName":${JSON.stringify(fields.agentName)}` : "";
  return `{"type":"event","threadId":${JSON.stringify(fields.threadId)},"name":${JSON.stringify(fields.name)},"payload":${JSON.stringify(fields.payload)}${agent}}`;
}

/** ui_request 帧的信封键（载荷平铺在帧上，这些键不可当载荷转发）。 */
const UI_REQUEST_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "type", "requestId", "threadId", "method"]);

export function uiRequestFrame(fields: {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}): string {
  const body = Object.entries(fields.payload)
    .filter(([key]) => !UI_REQUEST_ENVELOPE_KEYS.has(key))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(",");
  return `{"type":"ui_request","requestId":${JSON.stringify(fields.requestId)},"threadId":${JSON.stringify(fields.threadId)},"method":${JSON.stringify(fields.method)}${body === "" ? "" : `,${body}`}}`;
}

/**
 * ui_request 帧记录 → 载荷（uiRequestFrame 的读侧对称）。
 *
 * 载荷平铺在帧上而非 payload 子对象：网关转发到设备面时须按 L2 帧契约（UiRequestBody.payload）
 * 重新收拢，否则设备只拿到空载荷——权限卡会退化成无标题无命令的「确认操作」。
 */
export function uiRequestPayloadOf(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (UI_REQUEST_ENVELOPE_KEYS.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}

export function heartbeatFrame(fields: { rssBytes?: number | null; cpuPercent?: number }): string {
  const rss = fields.rssBytes !== undefined && fields.rssBytes !== null ? fields.rssBytes : null;
  return `{"type":"heartbeat","rssBytes":${rss},"cpuPercent":${fields.cpuPercent}}`;
}

export function hubErrorFrame(message: string, threadId?: string): string {
  const t = threadId !== undefined ? `,"threadId":${JSON.stringify(threadId)}` : "";
  return `{"type":"hub_error","message":${JSON.stringify(message)}${t}}`;
}

export function threadDiedFrame(threadId: string, reason: string): string {
  return `{"type":"thread_died","threadId":${JSON.stringify(threadId)},"reason":${JSON.stringify(reason)}}`;
}

export function threadParkedFrame(threadId: string, reason: "idle" | "manual" | "rss"): string {
  return `{"type":"thread_parked","threadId":${JSON.stringify(threadId)},"reason":${JSON.stringify(reason)}}`;
}
