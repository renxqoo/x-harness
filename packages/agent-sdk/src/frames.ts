import type { SdkErrorShape } from "./errors.ts";

export interface FrameClass {
  kind: "response";
  id?: string;
  command: string;
  success: boolean;
}

const RESPONSE_HEAD =
  /^\{"id":(?:"((?:[^"\\]|\\.)*)"|null|undefined)?,"type":"response","command":"([a-z_/]+)","success":(true|false)/;

const SETTLED_HEAD = /^\{"type":"event","threadId":"((?:[^"\\]|\\.)*)","name":"settled","payload":\{"sendId":"((?:[^"\\]|\\.)*)"/;

export function classifyResponseHead(line: string): FrameClass | undefined {
  const match = RESPONSE_HEAD.exec(line);
  if (match === null) return undefined;
  return {
    kind: "response",
    ...(match[1] !== undefined ? { id: JSON.parse(`"${match[1]}"`) as string } : {}),
    command: match[2] ?? "",
    success: match[3] === "true",
  };
}

export function settledHeadOf(line: string): { threadId: string; sendId: string } | undefined {
  const match = SETTLED_HEAD.exec(line);
  if (match === null) return undefined;
  return { threadId: JSON.parse(`"${match[1]}"`) as string, sendId: JSON.parse(`"${match[2]}"`) as string };
}

export function responseLine(fields: {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: SdkErrorShape;
}): string {
  const head = `{"id":${fields.id !== undefined ? JSON.stringify(fields.id) : "null"},"type":"response","command":${JSON.stringify(fields.command)},"success":${fields.success ? "true" : "false"}`;
  if (!fields.success && fields.error !== undefined) {
    return `${head},"error":${JSON.stringify(fields.error)}}`;
  }
  if (fields.success && fields.data !== undefined) {
    return `${head},"data":${JSON.stringify(fields.data)}}`;
  }
  return `${head}}`;
}

export function responseFrame(fields: {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: SdkErrorShape;
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

export function clientHeartbeatFrame(fields: { rssBytes?: number | null; cpuPercent?: number }): string {
  const rss = fields.rssBytes !== undefined && fields.rssBytes !== null ? fields.rssBytes : null;
  return `{"type":"heartbeat","rssBytes":${rss},"cpuPercent":${fields.cpuPercent}}`;
}

export function workerHeartbeatFrame(fields: { idleMs: number; streaming: boolean; sessionPath: string | null; rssBytes: number | null }): string {
  return `{"type":"heartbeat","idleMs":${fields.idleMs},"streaming":${fields.streaming},"sessionPath":${JSON.stringify(fields.sessionPath)},"rssBytes":${fields.rssBytes === null ? "null" : String(fields.rssBytes)}}`;
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

export function helloFrame(): string {
  return `{"type":"hello","protocolVersion":1,"backendId":"x-harness"}`;
}
