// 写侧与读侧共用的校验门：路径安全 / JSON 安全 / 逐词条形状 / seed 信封 + 投影重放（docs/SESSION.md §1.8、§7）。
// 垃圾输入一律返回失败理由，不抛不崩。

import { applySurfaceEvent, isSurfaceEventType } from "./surface.ts";
import type { SessionEvent, SessionEventType, SurfaceEventType, SurfaceNode, SurfaceOp } from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** SessionId 同时是磁盘目录名：拒绝路径分隔、越权段、超长与非 ASCII */
export function isSafeSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function isJsonSafe(value: unknown): boolean {
  try {
    return checkJsonSafe(value, new Set<object>());
  } catch {
    // 病态输入（如 getter 抛错）按不安全降级
    return false;
  }
}

/** 环检测按「祖先路径」判：DAG 重复引用（同一冻结块复用）合法，仅回到祖先判循环 */
function checkJsonSafe(value: unknown, path: Set<object>): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false; // undefined / function / symbol / bigint
  if (path.has(value)) return false; // 循环引用（回到祖先）
  path.add(value);
  const ok = Array.isArray(value)
    ? Object.keys(value).length === value.length && value.every((item) => checkJsonSafe(item, path)) // 稀疏数组（洞）在此被拒
    : (() => {
        const proto = Object.getPrototypeOf(value);
        // 原型须是 Object.prototype 或 null：既拒 Date/Map/类实例，也拒 `{__proto__: X}` 字面量
        // 设置的原型污染（其值不在自有键上，验证不可跳过）
        if (proto !== Object.prototype && proto !== null) return false;
        if (Object.getOwnPropertySymbols(value).length > 0) return false; // Symbol 键会被 JSON 静默丢弃
        return Object.values(value).every((item) => checkJsonSafe(item, path)); // 显式 undefined 值在此被拒
      })();
  path.delete(value);
  return ok;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isContentBlocks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((block) => {
      if (!isObj(block)) return false;
      if (block["type"] === "text") return isStr(block["text"]);
      if (block["type"] === "tool_use") {
        return isStr(block["callId"]) && isStr(block["name"]) && isStr(block["input"]);
      }
      return false;
    })
  );
}

function isTurnEndReason(value: unknown): boolean {
  if (!isObj(value)) return false;
  switch (value["kind"]) {
    case "completed":
    case "aborted":
    case "blocked":
    case "max-tokens":
    case "interrupted":
      return true;
    case "error":
      return isStr(value["message"]) && (value["code"] === undefined || isStr(value["code"]));
    default:
      return false;
  }
}

function isToolRefs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) => isObj(tool) && isStr(tool["name"]) && (tool["description"] === undefined || isStr(tool["description"])),
    )
  );
}

function isInboxTarget(value: unknown): boolean {
  return value === "next-turn" || value === "next-step";
}

function isInboxEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isObj(entry) && isStr(entry["id"]) && entry["id"] !== "" && isContentBlocks(entry["content"]))
  );
}

/** 逐词条形状门：词表闭合（13 条），结构与归属键检查，语义归写方 */
const shapeGates: { readonly [K in SessionEventType]: (data: unknown) => boolean } = {
  "turn/start": (d) => isObj(d) && isCount(d["turn"]),
  "turn/end": (d) => isObj(d) && isCount(d["turn"]) && isTurnEndReason(d["reason"]),
  "step/start": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]),
  "step/end": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]),
  "system/message": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["text"]),
  "user/message": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isContentBlocks(d["content"]),
  "assistant/message": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isContentBlocks(d["content"]) &&
    (d["stopReason"] === undefined || isStr(d["stopReason"])) &&
    (d["interrupted"] === undefined || d["interrupted"] === true),
  "assistant/attempt": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["error"]),
  "tool/call": (d) =>
    isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["callId"]) && isStr(d["name"]) && isStr(d["arguments"]),
  "tool/result": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["callId"]) &&
    isStr(d["content"]) &&
    (d["isError"] === undefined || d["isError"] === true),
  "request/header": (d) =>
    isObj(d) &&
    isStr(d["model"]) &&
    (d["provider"] === undefined || isStr(d["provider"])) &&
    (d["temperature"] === undefined || typeof d["temperature"] === "number") &&
    (d["maxTokens"] === undefined || isCount(d["maxTokens"])) &&
    isToolRefs(d["tools"]),
  "request/context": (d) =>
    isObj(d) && isStr(d["provider"]) && isStr(d["model"]) && (d["contextWindow"] === undefined || isCount(d["contextWindow"])),
  "session/end-seed": (d) => isObj(d) && (d["inherited"] === undefined || d["inherited"] === true),
  "agent/inbox/spliced": (d) => {
    if (!isObj(d)) return false;
    switch (d["op"]) {
      case "insert":
        return isInboxTarget(d["target"]) && isInboxEntries(d["entries"]);
      case "claim":
        return (
          isInboxTarget(d["target"]) &&
          isCount(d["turn"]) &&
          Array.isArray(d["claimed"]) &&
          d["claimed"].every((id) => isStr(id) && id !== "")
        );
      case "clear": // 清双队列，无 target
        return isStr(d["reason"]) && d["reason"] !== "";
      default:
        return false;
    }
  },
};

/** append 的第一道门：未知词条 / 非 JSON 安全 data / 形状不符 → 返回失败理由 */
export function gateEvent(type: string, data: unknown): string | undefined {
  const gate = (shapeGates as Record<string, ((data: unknown) => boolean) | undefined>)[type];
  if (gate === undefined) return `unknown-type:${type}`;
  if (!isJsonSafe(data)) return `not-json-safe:${type}`;
  return gate(data) ? undefined : `shape:${type}`;
}

/** replace 区间门：端点必须都是当前 surface 现存节点 */
export function gateSurfaceOp(op: SurfaceOp, surfaceSeqs: readonly number[]): string | undefined {
  if (op === "append") return undefined;
  if (op.startSeq > op.endSeq) return `replace-range:${op.startSeq}>${op.endSeq}`;
  if (!surfaceSeqs.includes(op.startSeq)) return `replace-target-missing:${op.startSeq}`;
  if (!surfaceSeqs.includes(op.endSeq)) return `replace-target-missing:${op.endSeq}`;
  return undefined;
}

/** intent 本体的运行时形状门（append 与 replace 之外一律非法；null/缺键/多余形状在此拦截） */
export function parseSurfaceOp(value: unknown): SurfaceOp | undefined {
  if (value === "append") return "append";
  if (isObj(value) && value["op"] === "replace" && isCount(value["startSeq"]) && isCount(value["endSeq"])) {
    return { op: "replace", startSeq: value["startSeq"], endSeq: value["endSeq"] };
  }
  return undefined;
}

/** seed（resume/fork 前缀/磁盘读回）的整卷校验：信封形状 + seq 连续 + surfaceOp 一致性 + 投影重放 */
export function validateSessionEvents(events: readonly unknown[]): string | undefined {
  let nodes: readonly SurfaceNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    if (!isObj(raw)) return `corrupt-envelope:${i}:not-object`;
    const type = raw["type"];
    if (typeof type !== "string") return `corrupt-envelope:${i}:type`;
    const gateErr = gateEvent(type, raw["data"]);
    if (gateErr !== undefined) return `corrupt-envelope:${i}:${gateErr}`;
    if (raw["seq"] !== i) return `corrupt-envelope:${i}:seq`;
    if (typeof raw["time"] !== "number" || !Number.isFinite(raw["time"])) return `corrupt-envelope:${i}:time`;
    const op = parseSurfaceOp(raw["surfaceOp"]);
    if (isSurfaceEventType(type)) {
      if (op === undefined) return `corrupt-envelope:${i}:surface-op`;
      if (op !== "append" && op.startSeq > op.endSeq) return `corrupt-envelope:${i}:replace-range`;
      const next = applySurfaceEvent(
        nodes,
        { seq: i, time: raw["time"], type, data: raw["data"], surfaceOp: op } as unknown as SessionEvent<SurfaceEventType>,
      );
      if (next === undefined) return `corrupt-surface:${i}`;
      nodes = next;
    } else if (op !== undefined) {
      return `corrupt-envelope:${i}:surface-op-not-allowed`;
    }
  }
  return undefined;
}
