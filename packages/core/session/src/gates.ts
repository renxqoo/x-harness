import { applySurfaceEvent, isSurfaceEventType } from "./surface.ts";
import { INBOX_TARGET_VALUES, THINKING_LEVELS, TODO_SNAPSHOT_STATUS_VALUES } from "./tokens.ts";
import { AGENT_MESSAGE_KINDS } from "./agent-message.ts";
import type { SessionEvent, SessionEventType, SurfaceEventType, SurfaceNode, SurfaceOp } from "./types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function isThinkingBlocks(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((block) => {
    if (typeof block !== "object" || block === null) return false;
    const record = block as Record<string, unknown>;
    const origin = record["origin"];
    return (
      typeof record["signature"] === "string" &&
      record["signature"] !== "" &&
      typeof record["redacted"] === "boolean" &&
      typeof origin === "object" &&
      origin !== null &&
      typeof (origin as Record<string, unknown>)["provider"] === "string" &&
      typeof (origin as Record<string, unknown>)["model"] === "string"
    );
  });
}

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
  return (INBOX_TARGET_VALUES as readonly string[]).includes(value as string);
}

function isIdList(value: unknown): boolean {
  return Array.isArray(value) && value.every((id) => isStr(id) && id !== "");
}

function isInboxClaim(d: Record<string, unknown>): boolean {
  return isInboxTarget(d["target"]) && isCount(d["turn"]) && isIdList(d["claimed"]);
}

function isInboxDrop(d: Record<string, unknown>): boolean {
  return isInboxTarget(d["target"]) && isIdList(d["dropped"]) && isStr(d["reason"]) && d["reason"] !== "";
}

function isInboxSpliceData(data: unknown): boolean {
  if (!isObj(data)) return false;
  const d = data as Record<string, unknown>;
  switch (d["op"]) {
    case "insert":
      return isInboxTarget(d["target"]) && isInboxEntries(d["entries"]);
    case "claim":
      return isInboxClaim(d);
    case "clear":
      return isStr(d["reason"]) && d["reason"] !== "";
    case "drop":
      return isInboxDrop(d);
    case "retarget":
      return isStr(d["id"]) && d["id"] !== "" && isInboxTarget(d["to"]);
    default:
      return false;
  }
}

function isEntryOrigin(value: unknown): boolean {
  return isObj(value) && isStr(value["source"]) && value["source"] !== "" && AGENT_MESSAGE_KINDS.has(value["kind"] as string);
}

function isInboxEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!isObj(entry) || !isStr(entry["id"]) || entry["id"] === "" || !isContentBlocks(entry["content"], true)) return false;
      return entry["origin"] === undefined || (isEntryOrigin(entry["origin"]) && isTextOnlyBlocks(entry["content"]));
    })
  );
}

function isTextOnlyBlocks(value: unknown): boolean {
  return Array.isArray(value) && value.every((block) => isObj(block) && block["type"] === "text" && isStr(block["text"]));
}

const TODO_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set<string>(TODO_SNAPSHOT_STATUS_VALUES);
const TODO_SNAPSHOT_TEXT_KEYS = ["description", "activeForm", "owner"] as const;

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
  const id = task["id"];
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id) || ids.has(id)) return false;
  if (typeof task["subject"] !== "string" || task["subject"] === "") return false;
  if (!TODO_SNAPSHOT_STATUSES.has(task["status"] as string)) return false;
  if (TODO_SNAPSHOT_TEXT_KEYS.some((key) => task[key] !== undefined && typeof task[key] !== "string")) return false;
  const metadata = task["metadata"];
  return metadata === undefined || (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
}

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
    (d["thinkingBlocks"] === undefined || isThinkingBlocks(d["thinkingBlocks"])) &&
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
    (d["thinkingBlocks"] === undefined || isThinkingBlocks(d["thinkingBlocks"])) &&
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
    (d["thinking"] === undefined || (THINKING_LEVELS as readonly string[]).includes(d["thinking"] as string)) &&
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
  "session/meta": (d) => isObj(d) && isStr(d["key"]) && d["key"] !== "",
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
    isTextOnlyBlocks(d["content"]),
};

export function gateEvent(type: string, data: unknown): string | undefined {
  const gate = (shapeGates as Record<string, ((data: unknown) => boolean) | undefined>)[type];
  if (gate === undefined) return `unknown-type:${type}`;
  return gate(data) ? undefined : `shape:${type}`;
}

export function parseSurfaceOp(value: unknown): SurfaceOp | undefined {
  if (value === "append") return "append";
  if (isObj(value) && value["op"] === "replace" && isCount(value["startSeq"]) && isCount(value["endSeq"])) {
    return { op: "replace", startSeq: value["startSeq"], endSeq: value["endSeq"] };
  }
  return undefined;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["type", "seq", "time", "data", "surfaceOp"]);

function envelopeExtraKey(raw: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) return key;
  }
  return undefined;
}

class CommandPairing {
  private readonly open = new Set<string>();
  private readonly matched = new Set<string>();

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
