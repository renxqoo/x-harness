// 写侧与读侧共用的校验门：路径安全 / 逐词条形状 / seed 信封白名单 + 投影重放（docs/SESSION.md §1.8、§7）。
// JSON 值域由 snapshot.ts 的 materializeJson 单一权威承担（调用方物化先行，门只看快照形状）；
// 垃圾输入一律返回失败理由，不抛不崩。

import { applySurfaceEvent, isSurfaceEventType } from "./surface.ts";
import { INBOX_TARGET_VALUES, THINKING_LEVELS, TODO_SNAPSHOT_STATUS_VALUES } from "./tokens.ts";
import { AGENT_MESSAGE_KINDS } from "./agent-message.ts";
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

/** 内容块形状门：user 域（user/message、inbox insert）放行 image；assistant 域拒——
 *  驱动永不铸 assistant image，损坏档案在恢复面 fail-closed（archive-corrupt） */
function isContentBlocks(value: unknown, allowImage: boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every((block) => {
      if (!isObj(block)) return false;
      if (block["type"] === "text") return isStr(block["text"]);
      if (block["type"] === "tool_use") {
        return isStr(block["callId"]) && isStr(block["name"]) && isStr(block["input"]);
      }
      if (block["type"] === "image") {
        return allowImage && isStr(block["data"]) && isStr(block["mediaType"]);
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
      return value["reason"] === undefined || isStr(value["reason"]);
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
  return INBOX_TARGET_VALUES.includes(value as string);
}

/** id 字符串数组（claim.claimed / drop.dropped 共用形状）。 */
function isIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((id) => isStr(id) && id !== "");
}

/** claim 消费（按 turn 记账）：target + turn + claimed。 */
function isInboxClaim(d: Record<string, unknown>): boolean {
  return isInboxTarget(d["target"]) && isCount(d["turn"]) && isIdList(d["claimed"]);
}

/** drop 单条移除（queue/drop 直写）：target + dropped + reason。 */
function isInboxDrop(d: Record<string, unknown>): boolean {
  return isInboxTarget(d["target"]) && isIdList(d["dropped"]) && isStr(d["reason"]) && d["reason"] !== "";
}

/** 收件箱拼接五 op 的形状门（insert/claim/clear/drop/retarget）。 */
function isInboxSpliceData(data: unknown): boolean {
  if (!isObj(data)) return false;
  const d = data as Record<string, unknown>;
  switch (d["op"]) {
    case "insert":
      return isInboxTarget(d["target"]) && isInboxEntries(d["entries"]);
    case "claim":
      return isInboxClaim(d);
    case "clear": // 清双队列，无 target
      return isStr(d["reason"]) && d["reason"] !== "";
    case "drop":
      return isInboxDrop(d);
    case "retarget": // 单条改道（queue/send_now 直写）
      return isStr(d["id"]) && d["id"] !== "" && isInboxTarget(d["to"]);
    default:
      return false;
  }
}

/** 条目材料化标记门（docs/AGENT-MESSAGE.md §4 场景 C）：source 非空 + kind 闭集 */
function isEntryOrigin(value: unknown): boolean {
  return isObj(value) && isStr(value["source"]) && value["source"] !== "" && AGENT_MESSAGE_KINDS.has(value["kind"] as string);
}

function isInboxEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!isObj(entry) || !isStr(entry["id"]) || entry["id"] === "" || !isContentBlocks(entry["content"], true)) return false;
      // 带 origin 的条目将材料化为 agent/message（text-only 门）——入口同口径收口，
      // 失败点不后移到运行中段（材料化 append 才炸 → 整轮 error）
      return entry["origin"] === undefined || (isEntryOrigin(entry["origin"]) && isTextOnlyBlocks(entry["content"]));
    })
  );
}

/** 内部消息 content 门（AGENT-MESSAGE.md §1 text-only 起步）：越约块（tool_use/image）
 *  会被三处消费方静默丢弃（serialize/pi-context 只读 text）——fail-closed 拒，不做无痕数据损失 */
function isTextOnlyBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.every((block) => isObj(block) && block["type"] === "text" && isStr(block["text"]));
}

/** todo/snapshot 词条门常量：status 闭合词表 + 可选串字段名 */
const TODO_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set(TODO_SNAPSHOT_STATUS_VALUES);
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

/** 逐词条形状门：词表闭合（18 条），结构与归属键检查，语义归写方 */
const shapeGates: { readonly [K in SessionEventType]: (data: unknown) => boolean } = {
  "turn/start": (d) => isObj(d) && isCount(d["turn"]),
  "turn/end": (d) => isObj(d) && isCount(d["turn"]) && isTurnEndReason(d["reason"]),
  "step/start": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]),
  "step/end": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]),
  "system/message": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["text"]),
  "user/message": (d) => isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isContentBlocks(d["content"], true),
  "assistant/message": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isContentBlocks(d["content"], false) &&
    (d["thinking"] === undefined || isStr(d["thinking"])) &&
    (d["usage"] === undefined || isObj(d["usage"])) &&
    (d["stopReason"] === undefined || isStr(d["stopReason"])) &&
    (d["interrupted"] === undefined || d["interrupted"] === true),
  "assistant/attempt": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["error"]) &&
    (d["content"] === undefined || isContentBlocks(d["content"], false)) &&
    (d["thinking"] === undefined || isStr(d["thinking"])) &&
    (d["usage"] === undefined || isObj(d["usage"])),
  "tool/call": (d) =>
    isObj(d) && isCount(d["turn"]) && isCount(d["step"]) && isStr(d["callId"]) && isStr(d["name"]) && isStr(d["arguments"]),
  "tool/result": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["callId"]) &&
    isStr(d["content"]) &&
    (d["isError"] === undefined || d["isError"] === true) &&
    (d["synthetic"] === undefined || d["synthetic"] === true),
  "request/header": (d) =>
    isObj(d) &&
    isStr(d["model"]) &&
    (d["provider"] === undefined || isStr(d["provider"])) &&
    (d["temperature"] === undefined || typeof d["temperature"] === "number") &&
    (d["maxTokens"] === undefined || isCount(d["maxTokens"])) &&
    (d["thinking"] === undefined || THINKING_LEVELS.includes(d["thinking"] as string)) &&
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
  "agent/inbox/spliced": isInboxSpliceData,
  "todo/snapshot": (d) => {
    if (!isObj(d) || !isCount(d["seq"])) return false;
    const ids = todoSnapshotTaskIds(d["tasks"], d["seq"]);
    return ids !== undefined && todoSnapshotEdges(d["edges"], ids);
  },
  "session/meta": (d) => isObj(d) && isStr(d["key"]) && d["key"] !== "", // value 语义归写方（内核只运不判）
  "command/run": (d) => isObj(d) && isStr(d["commandId"]) && d["commandId"] !== "" && isStr(d["name"]) && (d["args"] === undefined || isStr(d["args"])),
  "command/done": (d) =>
    isObj(d) &&
    isStr(d["commandId"]) &&
    d["commandId"] !== "" &&
    (d["kind"] === "success" || d["kind"] === "error") &&
    (d["text"] === undefined || isStr(d["text"])),
  "agent/message": (d) =>
    isObj(d) &&
    isCount(d["turn"]) &&
    isCount(d["step"]) &&
    isStr(d["source"]) &&
    d["source"] !== "" &&
    AGENT_MESSAGE_KINDS.has(d["kind"] as string) &&
    isTextOnlyBlocks(d["content"]), // text-only 起步（AGENT-MESSAGE.md §1；tool_use/image 后开走 §4 场景 B）
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

/** 命令配对账（BATCH3-DESIGN §2.2，at-most-once 双向）：run 登记（重复 corrupt）；
 *  done 必须命中未配对的 run（消费之）。悬挂 run（无 done）合法——torn 卷可恢复 */
class CommandPairing {
  private readonly open = new Set<string>();
  private readonly matched = new Set<string>();

  /** 配对违规理由，或 undefined 放行 */
  check(raw: Record<string, unknown>): string | undefined {
    const data = raw["data"];
    const commandId = isObj(data) ? data["commandId"] : undefined;
    if (typeof commandId !== "string" || commandId === "") return undefined;
    if (raw["type"] === "command/run") {
      if (this.open.has(commandId) || this.matched.has(commandId)) {
        return `command-run-duplicate:${commandId}`;
      }
      this.open.add(commandId);
      return undefined;
    }
    if (raw["type"] === "command/done") {
      if (!this.open.has(commandId)) return `command-done-unpaired:${commandId}`;
      this.open.delete(commandId);
      this.matched.add(commandId);
    }
    return undefined;
  }
}

/** 单事件信封静态校验（白名单键/形状门/seq/time）——形状归 gateEvent，此处只查信封 */
function envelopeError(raw: Record<string, unknown>, i: number): string | undefined {
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
  return undefined;
}

export function validateSessionEvents(events: readonly unknown[]): string | undefined {
  let nodes: readonly SurfaceNode[] = [];
  const commandPairing = new CommandPairing();
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    if (!isObj(raw)) return `corrupt-envelope:${i}:not-object`;
    const pairingError = commandPairing.check(raw);
    if (pairingError !== undefined) return `corrupt-envelope:${i}:${pairingError}`;
    const staticError = envelopeError(raw, i);
    if (staticError !== undefined) return staticError;
    const type = raw["type"] as string;
    const time = raw["time"] as number;
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
