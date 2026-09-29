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
