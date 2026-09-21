// 帧头分类（DESIGN §9 热路径）：数据类响应按行首正则提取 id/command/success
// 三个字段就转发——不 JSON.parse、不读 body（转发路径 <1ms 零解析）。key 顺序
// 契约：帧字面量由 frames.ts 单点生成（id,type,command,success 次序），正则与
// 字面量成对（单测锁定）。error 为结构化错误通道（shared/errors 词表）。
import type { HubErrorShape } from "./errors.ts";

export interface FrameClass {
  kind: "response";
  /** 回显 id（无 id 响应为 undefined——parse failure） */
  id?: string;
  command: string;
  /** 响应成败（受理对账面——被拒驱动无 settled 义务的判据） */
  success: boolean;
}

const RESPONSE_HEAD =
  /^\{"id":(?:"((?:[^"\\]|\\.)*)"|null|undefined)?,"type":"response","command":"([a-z_/]+)","success":(true|false)/;

/** 仅识别 response 帧头；其余帧（event/heartbeat/...）不经本路径（前缀分派直达）。
 *  id 必须解码回原值——对账与 pending 表比对的是未转义字符串。 */
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

/** 响应帧字面量构造（key 顺序 = 分类正则的契约面；两侧共用单份） */
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
