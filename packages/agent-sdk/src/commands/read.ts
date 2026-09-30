import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import { pluginManagerService } from "@x-harness/plugin-manager";
import type { Session, SessionId } from "@x-harness/session";
import { hubError } from "../shared/errors.ts";
import { foldQueue } from "../shared/inbox-fold.ts";
import { WORKER_RESPONSE_SOFT_CAP } from "../shared/limits.ts";
import { entryWindowViewed } from "./entries-window.ts";
import { listCommands } from "./command-listing.ts";
import { currentDialOf, titleOf } from "./meta-state.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface ReadCommandState {
  session: Session | undefined;
  threadId: string;
  sessionsRoot: string;
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  commands: { list(): unknown[] } | undefined;
  world: {
    meter: { usageOf(id: SessionId): { inputTokens: number; outputTokens: number; totalTokens: number; costTotal?: number } | undefined };
    ctxTryUse(token: unknown): unknown;
    storeFlush(id: SessionId): Promise<{ ok: true } | { ok: false; reason: string } | undefined>;
  } | undefined;
  delegation: { list(id: SessionId): Promise<readonly { kind: string; agentId: string }[]> } | undefined;
  broker: { pendingAll(): unknown };
  inflightState: { snapshot(): unknown };
  bash: { readLatest(): unknown };
  bridge: { isStreaming(): boolean; commandBusy(): boolean };
  dial: import("../shared/meta-fold.ts").DialFact;
}

function noThread(command: string): CommandOutcome {
  return { command, error: hubError("unknown_thread", "Unknown threadId") };
}

export function getState(state: ReadCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_state");
  const events = session.events();
  let messageCount = 0;
  for (const event of events) {
    if (event.type === "user/message" || event.type === "assistant/message") messageCount += 1;
  }
  return {
    command: "get_state",
    data: {
      model: currentDialOf(events, state.dial),
      isStreaming: state.bridge.isStreaming(),
      isCompacting: state.bridge.commandBusy(),
      sessionId: state.threadId,
      sessionName: titleOf(events) ?? "",
      sessionFile: sessionPathOf(state),
      messageCount,
      queue: foldQueue(events),
    },
  };
}

function sessionPathOf(state: ReadCommandState): string {
  return `${state.sessionsRoot}/${state.threadId}/events.jsonl`;
}

export function getInflight(state: ReadCommandState): CommandOutcome {
  if (state.session === undefined) return noThread("get_inflight");
  return { command: "get_inflight", data: { ...(state.inflightState.snapshot() as object), bash: state.bash.readLatest() } };
}

export function withinResponseBudget(messages: readonly unknown[], cap: number): boolean {
  let budget = cap - 4096;
  for (const message of messages) {
    budget -= Buffer.byteLength(JSON.stringify(message), "utf8");
    if (budget < 0) return false;
  }
  return true;
}

export function getMessages(state: ReadCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_messages");
  const messages = session.deriveMessages();
  if (!withinResponseBudget(messages, WORKER_RESPONSE_SOFT_CAP)) {
    return { command: "get_messages", error: hubError("thread_limit", "response too large; use get_entries") };
  }
  return { command: "get_messages", data: { messages } };
}

export function getEntries(state: ReadCommandState, input: Record<string, unknown>): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_entries");
  const result = entryWindowViewed(session.events(), {
    ...(typeof input.since === "number" ? { since: input.since } : {}),
    ...(typeof input.before === "number" ? { before: input.before } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(input.view !== undefined ? { view: input.view } : {}),
  });
  if (!result.ok) return { command: "get_entries", error: hubError(result.code, result.reason) };
  return { command: "get_entries", data: { entries: result.entries, leafSeq: result.leafSeq, hasMore: result.hasMore } };
}

interface SubtreeWalk {
  readonly headers: readonly { id: unknown; parentSession?: unknown; agentId?: unknown }[];
  readonly seen: Set<string>;
  readonly children: string[];
}

export function descendantsOf(root: string, headers: readonly { id: unknown; parentSession?: unknown; agentId?: unknown }[]): string[] {
  const walk: SubtreeWalk = { headers, seen: new Set<string>([root]), children: [] };
  let frontier = [root];
  for (let depth = 0; depth < headers.length && frontier.length > 0; depth += 1) {
    frontier = expandFrontier(walk, frontier);
  }
  return walk.children;
}

function expandFrontier(walk: SubtreeWalk, frontier: readonly string[]): string[] {
  const next: string[] = [];
  for (const parent of frontier) {
    for (const header of walk.headers) {
      const id = String(header.id);
      if (header.agentId !== undefined || String(header.parentSession) !== parent || walk.seen.has(id)) continue;
      walk.seen.add(id);
      walk.children.push(id);
      next.push(id);
    }
  }
  return next;
}

export async function getTree(state: ReadCommandState): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return noThread("get_tree");
  try {
    const headers = await createArchiveReader(state.sessionsRoot).listHeaders();
    const byId = new Map(headers.map((header) => [String(header.id), header]));
    const ancestors: string[] = [];
    let cursor = byId.get(state.threadId)?.parentSession;
    while (cursor !== undefined) {
      const id = String(cursor);
      if (ancestors.includes(id)) break;
      ancestors.push(id);
      cursor = byId.get(id)?.parentSession;
    }
    const children = descendantsOf(state.threadId, headers);
    return {
      command: "get_tree",
      data: { ancestors, children, leafSeq: session.events().length - 1 },
    };
  } catch {
    return { command: "get_tree", error: hubError("session_unreadable", "Session file not readable") };
  }
}

function countStats(events: readonly { type: string }[]): { userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number } {
  const out = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 };
  for (const event of events) {
    if (event.type === "user/message") out.userMessages += 1;
    else if (event.type === "assistant/message") out.assistantMessages += 1;
    else if (event.type === "tool/call") out.toolCalls += 1;
    else if (event.type === "tool/result") out.toolResults += 1;
  }
  return out;
}

export function getSessionStats(state: ReadCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_session_stats");
  const counts = countStats(session.events());
  const usage = state.world?.meter.usageOf(session.id);
  return {
    command: "get_session_stats",
    data: {
      userMessages: counts.userMessages,
      assistantMessages: counts.assistantMessages,
      toolCalls: counts.toolCalls,
      toolResults: counts.toolResults,
      tokens: {
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        total: usage?.totalTokens ?? 0,
        ...(usage?.costTotal !== undefined ? { cost: usage.costTotal } : {}),
      },
    },
  };
}

interface TokenAnalyticsFace {
  breakdown(sessionId?: string): Record<string, number>;
  sessionOutput(session: string): number;
}

export function getTokenAnalytics(state: ReadCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_token_analytics");
  const svc = state.world?.ctxTryUse?.(pluginManagerService) as { serviceToken(name: string): unknown } | undefined;
  const token = svc?.serviceToken("token-analytics");
  const analytics = state.world !== undefined && token !== undefined ? (state.world.ctxTryUse?.(token) as TokenAnalyticsFace | undefined) : undefined;
  if (analytics === undefined) {
    return { command: "get_token_analytics", error: hubError("capability_plugin", "token analytics plugin not loaded") };
  }
  return {
    command: "get_token_analytics",
    data: { breakdown: analytics.breakdown(state.threadId), sessionOutput: analytics.sessionOutput(state.threadId) },
  };
}

export async function setSessionName(state: ReadCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const session = state.session;
  if (session === undefined) return noThread("set_session_name");
  const name = input.name;
  if (typeof name !== "string" || name.trim() === "") {
    return { command: "set_session_name", error: hubError("invalid_input", "invalid name: non-empty string required") };
  }
  const append = session.append("session/meta", { key: "title", value: name });
  if (!append.ok) return { command: "set_session_name", error: hubError("io_failed", append.reason) };
  const flushed = await state.world?.storeFlush?.(session.id);
  if (flushed !== undefined && !flushed.ok) return { command: "set_session_name", error: hubError("io_failed", flushed.reason) };
  return { command: "set_session_name" };
}

export async function getCommands(state: ReadCommandState): Promise<CommandOutcome> {
  if (state.session === undefined) return noThread("get_commands");
  return {
    command: "get_commands",
    data: await listCommands({ skillsDirs: state.skillsDirs, disabled: state.skillsDisabled, commands: (state.commands?.list() ?? []) as never }),
  };
}

export function getForkMessages(state: ReadCommandState): CommandOutcome {
  const session = state.session;
  if (session === undefined) return noThread("get_fork_messages");
  const forkable: Array<{ seq: number; text: string }> = [];
  for (const node of session.surface()) {
    const event = node.event;
    if (event.type !== "user/message") continue;
    const text = event.data.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "image") return `[image: ${block.mediaType}]`;
        return "";
      })
      .join("");
    if (text !== "") forkable.push({ seq: event.seq, text });
  }
  return { command: "get_fork_messages", data: forkable };
}

export async function getSubagents(state: ReadCommandState): Promise<CommandOutcome> {
  if (state.session === undefined) return noThread("get_subagents");
  const view = state.delegation;
  const rows = view === undefined ? [] : await view.list(state.threadId as never);
  return { command: "get_subagents", data: { subagents: rows } };
}

export function getPendingDialogs(state: ReadCommandState): CommandOutcome {
  if (state.session === undefined) return noThread("get_pending_dialogs");
  return { command: "get_pending_dialogs", data: { dialogs: state.broker.pendingAll() } };
}

export function getPlugins(state: ReadCommandState): CommandOutcome {
  if (state.session === undefined) return noThread("get_plugins");
  const svc = state.world?.ctxTryUse?.(pluginManagerService) as { list(): Array<{ name: string; mode: string; status: string }> } | undefined;
  const loaded = svc === undefined ? [] : svc.list().map((record) => ({ name: record.name, mode: record.mode, status: record.status }));
  return { command: "get_plugins", data: { loaded } };
}
