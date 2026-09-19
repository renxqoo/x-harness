// 写侧与读侧共用的校验门：路径安全 / 逐词条形状 / seed 信封白名单 + 投影重放（docs/SESSION.md §1.8、§7）。
// JSON 值域由 snapshot.ts 的 materializeJson 单一权威承担（调用方物化先行，门只看快照形状）；
// 垃圾输入一律返回失败理由，不抛不崩。

import { applySurfaceEvent, isSurfaceEventType } from "./surface.ts";
import type { SessionEvent, SessionEventType, SurfaceEventType, SurfaceNode, SurfaceOp } from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** SessionId 同时是磁盘目录名：拒绝路径分隔、越权段、超长与非 ASCII */
export function isSafeSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStr(value: unknown): value is string {
  return typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
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
      return value["cause"] === undefined || isStr(value["cause"]);
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

/** todo/snapshot 词条门常量：status 闭合词表 + 可选串字段名 */
const TODO_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
const TODO_SNAPSHOT_TEXT_KEYS = ["description", "activeForm", "owner"] as const;

/** todo/snapshot 词条门子函数（docs/TODO.md §13.2）：tasks 数组级校验 + id 收集（含 seq 下界）；失败 undefined */
function todoSnapshotTaskIds(value: unknown, seq: number): ReadonlySet<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  let maxId = 0;
  for (const task of value) {
    if (!todoSnapshotTaskOk(task, ids)) return undefined;
    const id = (task as Record<string, unknown>)["id"] as string;
    ids.add(id);
    maxId = Math.max(maxId, Number(id));
  }
  return seq >= maxId ? ids : undefined;
}

function todoSnapshotTaskOk(task: unknown, ids: ReadonlySet<string>): boolean {
  if (!isObj(task)) return false;
  // 规范形十进制（拒 "01"/"0"——数值同序字面不等会破恢复侧排序与唯一性）
  const id = task["id"];
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id) || ids.has(id)) return false;
  if (typeof task["subject"] !== "string" || task["subject"] === "") return false;
  if (!TODO_SNAPSHOT_STATUSES.has(task["status"] as string)) return false;
  if (TODO_SNAPSHOT_TEXT_KEYS.some((key) => task[key] !== undefined && typeof task[key] !== "string")) return false;
  const metadata = task["metadata"];
  return metadata === undefined || (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
}

/** edges 二元组校验：blocker ≠ blocked（自环——工具面拒的态门也拒）、两端 id 在场 */
function todoSnapshotEdges(value: unknown, ids: ReadonlySet<string>): boolean {
  if (!Array.isArray(value)) return false;
  for (const edge of value) {
    if (!Array.isArray(edge) || edge.length !== 2) return false;
    const [blocker, blocked] = edge as [unknown, unknown];
    if (typeof blocker !== "string" || typeof blocked !== "string") return false;
    if (blocker === blocked || !ids.has(blocker) || !ids.has(blocked)) return false;
  }
  return true;
}

/** 逐词条形状门：词表闭合（17 条），结构与归属键检查，语义归写方 */
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
    (d["usage"] === undefined || isObj(d["usage"])) &&
    (d["stopReason"] === undefined || isStr(d["stopReason"])) &&
    (d["interrupted"] === undefined || d["interrupted"] === true),
  "assistant/attempt": (d) =>
    isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["error"]) && (d["usage"] === undefined || isObj(d["usage"])),
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
    (d["thinking"] === undefined || ["off", "low", "medium", "high"].includes(d["thinking"] as string)) &&
    isToolRefs(d["tools"]),
  "request/context": (d) =>
    isObj(d) && isStr(d["provider"]) && isStr(d["model"]) && (d["contextWindow"] === undefined || isCount(d["contextWindow"])),
  "llm/retry": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["provider"]) &&
    d["provider"] !== "" &&
    isCount(d["retry"]) &&
    d["retry"] >= 1 &&
    isCount(d["delayMs"]) &&
    d["delayMs"] <= 2_147_483_647 &&
    isObj(d["failure"]) &&
    isStr(d["failure"]["message"]) &&
    d["failure"]["message"] !== "" &&
    (d["failure"]["code"] === undefined || isStr(d["failure"]["code"])),
  "session/end-seed": (d) => isObj(d) && (d["inherited"] === undefined || d["inherited"] === true),
  "autocompact/checkpoint": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["ledger"]) &&
    d["ledger"] !== "" &&
    isCount(d["coveredSeq"]) &&
    (d["stale"] === undefined || d["stale"] === true),
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
  "todo/snapshot": (d) => {
    if (!isObj(d) || !isCount(d["seq"])) return false;
    const ids = todoSnapshotTaskIds(d["tasks"], d["seq"]);
    return ids !== undefined && todoSnapshotEdges(d["edges"], ids);
  },

};

/** 形状门：未知词条 / 形状不符 → 返回失败理由（data 须为已物化快照或 JSON.parse 产物） */
export function gateEvent(type: string, data: unknown): string | undefined {
  const gate = (shapeGates as Record<string, ((data: unknown) => boolean) | undefined>)[type];
  if (gate === undefined) return `unknown-type:${type}`;
  return gate(data) ? undefined : `shape:${type}`;
}

/** intent 本体的运行时形状门（append 与 replace 之外一律非法；null/缺键/多余形状在此拦截） */
export function parseSurfaceOp(value: unknown): SurfaceOp | undefined {
  if (value === "append") return "append";
  if (isObj(value) && value["op"] === "replace" && isCount(value["startSeq"]) && isCount(value["endSeq"])) {
    return { op: "replace", startSeq: value["startSeq"], endSeq: value["endSeq"] };
  }
  return undefined;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["type", "seq", "time", "data", "surfaceOp"]);

/** seed（resume/磁盘读回）的整卷校验：信封白名单 + 形状 + seq 连续 + surfaceOp 一致性 + 投影重放。
 *  输入须为已物化快照（store 侧物化先行）或 JSON.parse 产物 */
function envelopeExtraKey(raw: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) return key;
  }
  return undefined;
}

export function validateSessionEvents(events: readonly unknown[]): string | undefined {
  let nodes: readonly SurfaceNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    if (!isObj(raw)) return `corrupt-envelope:${i}:not-object`;
    const extraKey = envelopeExtraKey(raw);
    if (extraKey !== undefined) return `corrupt-envelope:${i}:extra-key:${extraKey}`;
    const type = raw["type"];
    if (typeof type !== "string") return `corrupt-envelope:${i}:type`;
    const gateErr = gateEvent(type, raw["data"]);
    if (gateErr !== undefined) return `corrupt-envelope:${i}:${gateErr}`;
    if (raw["seq"] !== i) return `corrupt-envelope:${i}:seq`;
    const time = raw["time"];
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || Object.is(time, -0)) {
      return `corrupt-envelope:${i}:time`;
    }
    const op = parseSurfaceOp(raw["surfaceOp"]);
    if (isSurfaceEventType(type)) {
      if (op === undefined) return `corrupt-envelope:${i}:surface-op`;
      const step = applySurfaceEvent(
        nodes,
        { seq: i, time, type, data: raw["data"], surfaceOp: op } as unknown as SessionEvent<SurfaceEventType>,
      );
      if (!step.ok) return `corrupt-surface:${i}:${step.reason}`;
      nodes = step.nodes;
    } else if (Object.hasOwn(raw, "surfaceOp")) {
      return `corrupt-envelope:${i}:surface-op-not-allowed`;
    }
  }
  return undefined;
}
