// 输出帧（host→client 与 worker→host 共用字面量）：response 走 frame-classify 单点
// （key 顺序契约）；event 帧打 threadId/name/payload/agentName? 标签；合成域事件
// （settled / bash_execution_update）的载荷形状在此定义（DESIGN 附录 C）。
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
  error?: string;
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

export function uiRequestFrame(fields: {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}): string {
  const body = Object.entries(fields.payload)
    .filter(([key]) => key !== "__proto__" && key !== "type" && key !== "requestId" && key !== "threadId" && key !== "method")
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(",");
  return `{"type":"ui_request","requestId":${JSON.stringify(fields.requestId)},"threadId":${JSON.stringify(fields.threadId)},"method":${JSON.stringify(fields.method)}${body === "" ? "" : `,${body}`}}`;
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
