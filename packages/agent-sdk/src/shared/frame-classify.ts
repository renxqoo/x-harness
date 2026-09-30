import type { HubErrorShape } from "./errors.ts";

export interface FrameClass {
  kind: "response";
  id?: string;
  command: string;
  success: boolean;
}

const RESPONSE_HEAD =
  /^\{"id":(?:"((?:[^"\\]|\\.)*)"|null|undefined)?,"type":"response","command":"([a-z_/]+)","success":(true|false)/;

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

export function responseLine(fields: {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: HubErrorShape;
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
