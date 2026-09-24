// TypeBox 校验封装（docs/TOOLS.md §1.4）：Value.Errors 按 [Kind] symbol 派发——只许 Type.* 构造。
// register 探活用结构性 Kind 巡检（探活值驱动的求值对零错误路径不求值，optional/items 下的垃圾节点漏检）；
// 严格校验无强制转换，违规回显收到的 args 让模型自纠错。

import { Value } from "@sinclair/typebox/value";
import { Kind } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";

/** 子 schema 承载键（TypeBox 标准结构）；options 元数据键不巡检（TypeBox 不读它，无害） */
const NODE_KEYS = [
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "schema", // Optional/Readonly 等修饰节点的内层引用
  "then",
  "else",
] as const;

/** name→schema 映射键：巡检其值而非映射本身 */
const MAP_KEYS = ["properties", "patternProperties", "$defs"] as const;

function assertSchemaKinds(node: unknown, seen: WeakSet<object>): void {
  if (typeof node !== "object" || node === null) throw new Error("invalid-input-schema:not-object");
  if (seen.has(node)) return;
  seen.add(node);
  if (typeof (node as Record<symbol, unknown>)[Kind] !== "string") {
    throw new Error("invalid-input-schema:missing-kind");
  }
  const record = node as Record<string, unknown>;
  for (const key of NODE_KEYS) {
    const child = record[key];
    if (child === undefined) continue;
    if (Array.isArray(child)) {
      for (const item of child) assertSchemaKinds(item, seen);
    } else {
      assertSchemaKinds(child, seen);
    }
  }
  for (const key of MAP_KEYS) {
    const map = record[key];
    if (map === undefined || map === null || typeof map !== "object" || Array.isArray(map)) continue;
    for (const child of Object.values(map)) assertSchemaKinds(child, seen);
  }
}

/** register 探活：schema 图内任何子节点缺 [Kind]（手写/被篡改的 JSON Schema）在此 throw */
export function probeSchema(schema: unknown): void {
  assertSchemaKinds(schema, new WeakSet());
}

/** 违规清单（path + 信息；无违规返回 undefined） */
export function violationsOf(schema: TSchema, value: unknown): string | undefined {
  const errors = [...Value.Errors(schema, value)];
  if (errors.length === 0) return undefined;
  return errors.map((error) => `${error.path === "" ? "/" : error.path}: ${error.message}`).join("; ");
}

/** 违规回显截断（docs/TRUNCATED-TOOL-RESCUE.md 批 1a + WER C3 参数化后门）：全量回显对
 *  超长 args（如半截 write 原文）会把已烧掉的输出再按输入侧收一遍税——头 2_000 字符 +
 *  尾标（与 maxToolResultChars 同哲学），N 为截断前总字符数。max 参数化（缺省 2_000 不变
 *  ——调参归调用方，内核不持策略）。 */
export function formatArgsEcho(args: unknown, max = 2_000): string {
  // Symbol：stringify 返回 undefined；BigInt：stringify 直接抛——两者都能无损文本化
  if (typeof args === "symbol" || typeof args === "bigint") return String(args);
  let text: string;
  try {
    text = JSON.stringify(args) ?? "undefined";
  } catch {
    return "<unserializable args>";
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[${String(text.length)} chars truncated]`;
}
