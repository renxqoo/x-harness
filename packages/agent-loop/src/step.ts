import { createHash } from "node:crypto";
import type { LlmChunk, LlmRuntime } from "@x-harness/llm";
import { anchorIndexOf } from "@x-harness/session";
import type { ContentBlock, InboxEntry, InboxTarget, Session, SessionEvent } from "@x-harness/session";
import type { SystemPromptService } from "@x-harness/system-prompt";
import type { ToolRegistry } from "@x-harness/tools";
import { claimStepBatch, claimTurnBatch, foldInbox, insertData, turnClaimBatch } from "./inbox.ts";
import type { InboxState } from "./inbox.ts";
import { executeToolCalls, isTruncatedArguments, mustAppendPair, TRUNCATED_TOOL_MESSAGE } from "./tool-calls.ts";
import type { ToolCallOutcomeCollected, ToolCallSpec } from "./tool-calls.ts";
import { foldDial, headerChanged, lastRequestContext, toToolRefs } from "./request.ts";
import type { Dial, RequestErrorDecision } from "./tokens.ts";

export interface DriverDeps {
  readonly session: Session;
  readonly options: ResolvedOptions;
  readonly llm: LlmRuntime;
  readonly tools: ToolRegistry;
  readonly prompt: SystemPromptService;
  readonly emitStatus: (status: "idle" | "running") => void;
  readonly emitError: (turn: number, message: string) => void;
  readonly emitStreamFrame: (turn: number, step: number, frame: unknown) => void;
  readonly emitToolStream?: (callId: string, delta: string) => void;
  readonly dispatchPreStep: (payload: unknown) => Promise<unknown>;
  readonly dispatchRequest: (payload: unknown, dial: Dial) => Promise<Dial>;
  readonly dispatchRequestError: (payload: unknown) => Promise<RequestErrorDecision | undefined>;
  readonly dispatchTurnStopping: (payload: unknown) => Promise<void>;
  readonly dispatchTurnConclude: (payload: unknown) => Promise<unknown>;
  readonly dispatchTruncatedTool: (payload: unknown) => Promise<unknown>;
  readonly dispatchAssistantSettle: (payload: unknown) => Promise<unknown>;
  readonly dispatchLlmStream: (request: unknown) => Promise<AsyncIterable<LlmChunk>>;
}

export interface ResolvedOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: import("@x-harness/llm").ThinkingLevel;
  readonly systemPrompt?: string;
  readonly maxParallelToolCalls: number;
  readonly maxToolResultChars: number;
  readonly streamIdleTimeoutMs: number;
}

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted"; readonly cause: string }
  | { readonly kind: "blocked"; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string; readonly code?: string }
  | { readonly kind: "max-tokens" };

const OUTCOME_RANK: Record<TurnOutcome["kind"], number> = { completed: 0, "max-tokens": 1, error: 2, aborted: 3, blocked: 4 };

export function mergeOutcome(current: TurnOutcome | undefined, next: TurnOutcome): TurnOutcome {
  if (current === undefined) return next;
  if (OUTCOME_RANK[next.kind] >= OUTCOME_RANK[current.kind]) return next;
  return current;
}

export function abortedOutcome(cause: string | undefined): TurnOutcome {
  return { kind: "aborted", cause: cause ?? "signal" };
}

export function appendEvent(session: Session, type: string, data: unknown): SessionEvent {
  const result = session.append(type as never, data as never);
  if (!result.ok) throw new Error(`append-failed:${type}:${result.reason}`);
  return result.value;
}

export function appendSurfaceEvent(session: Session, spec: { readonly type: string; readonly data: unknown; readonly surfaceOp: unknown }): SessionEvent {
  const result = session.append(spec.type as never, spec.data as never, { surfaceOp: spec.surfaceOp } as never);
  if (!result.ok) throw new Error(`append-failed:${spec.type}:${result.reason}`);
  return result.value;
}

export interface TurnScope {
  readonly deps: DriverDeps;
  readonly controller: AbortController;
  readonly turn: number;
}

export type StepEntry =
  | { readonly kind: "enter"; readonly entries: readonly InboxEntry[] }
  | { readonly kind: "blocked"; readonly reason?: string }
  | { readonly kind: "empty" };

export type AssistantSettled = {
  readonly content: readonly ContentBlock[];
  readonly stopReason: "stop" | "max-tokens";
  readonly rawReason?: string;
  readonly hasThinking?: true;
  readonly interrupted?: true;
};

export type ToolFlow =
  | { readonly kind: "none"; readonly hasTools: boolean; readonly truncatedCount: number }
  | { readonly kind: "ran"; readonly collected: ToolCallOutcomeCollected; readonly hasTools: boolean; readonly truncatedCount: number }
  | { readonly kind: "aborted" };

export async function beginStep(scope: TurnScope, step: number, isStep0: boolean): Promise<StepEntry> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const inbox = foldInbox(session.events());
  const batch = isStep0 ? claimTurnBatch(inbox) : claimStepBatch(inbox);
  if (batch.claimed.length > 0) {
    appendEvent(session, "agent/inbox/spliced", {
      op: "claim",
      target: isStep0 ? "next-turn" : "next-step",
      turn,
      claimed: batch.claimed,
    });
  }
  if (isStep0 && batch.entries.length === 0) return { kind: "empty" };
  const decision = await deps.dispatchPreStep({
    session: session.id,
    turn,
    step,
    messages: session.deriveMessages(),
    claim: batch.entries,
    signal: controller.signal,
  });
  if (isEnterDecision(decision)) {
    const rewritten = (decision as { readonly messages?: readonly InboxEntry[] }).messages;
    if (rewritten !== undefined) {
      if (!isRewrittenEntries(rewritten)) {
        throw new Error(`pre-step rewrite shape invalid: messages must be an array of { id, content } (got ${JSON.stringify(rewritten).slice(0, 80)})`);
      }
      if (isStep0 && rewritten.length === 0) {
        appendEvent(session, "agent/inbox/spliced", { op: "clear", reason: "rewritten-empty" });
        return { kind: "empty" };
      }
      return { kind: "enter", entries: rewritten };
    }
    return { kind: "enter", entries: batch.entries };
  }
  reinsertClaimed(session, inbox, isStep0);
  const rejectReason = rejectReasonOf(decision);
  return { kind: "blocked", ...(rejectReason !== undefined ? { reason: rejectReason } : {}) };
}

function rejectReasonOf(decision: unknown): string | undefined {
  if (typeof decision !== "object" || decision === null) return undefined;
  const reason = (decision as { reason?: unknown }).reason;
  return typeof reason === "string" && reason !== "" ? reason : undefined;
}

export async function concludeStepEntry(scope: TurnScope, step: number): Promise<StepEntry> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const decision = await deps.dispatchPreStep({
    session: session.id,
    turn,
    step,
    messages: session.deriveMessages(),
    claim: [],
    signal: controller.signal,
  });
  if (isEnterDecision(decision)) return { kind: "enter", entries: [] };
  const reason = rejectReasonOf(decision);
  return { kind: "blocked", ...(reason !== undefined ? { reason } : {}) };
}

function reinsertClaimed(session: Session, inbox: InboxState, isStep0: boolean): void {
  const turnEntries = isStep0 ? turnClaimBatch(inbox.nextTurn) : [];
  insertBatch(session, "next-turn", turnEntries);
  insertBatch(session, "next-step", inbox.nextStep);
}

function insertBatch(session: Session, target: InboxTarget, entries: readonly InboxEntry[]): void {
  if (entries.length === 0) return;
  appendEvent(session, "agent/inbox/spliced", { op: "insert", target, entries: [...entries] });
}

export function anchorSystem(scope: TurnScope, step: number): void {
  const { deps, turn } = scope;
  const session = deps.session;
  const systemText = deps.options.systemPrompt ?? deps.prompt.assemble({ sessionId: session.id }).text;
  const nodes = session.surface();
  const anchorIndex = anchorIndexOf(nodes);
  let changed = false;
  if (anchorIndex < 0) {
    appendSurfaceEvent(session, { type: "system/message", data: { turn, step, text: systemText }, surfaceOp: "append" });
    changed = true;
  } else {
    const anchor = nodes[anchorIndex];
    if (anchor !== undefined) {
      const anchorText = (anchor.event.data as { text: string }).text ?? "";
      if (anchorText !== systemText) {
        appendSurfaceEvent(session, { type: "system/message", data: { turn, step, text: systemText }, surfaceOp: { op: "replace", startSeq: anchor.seq, endSeq: anchor.seq } });
        changed = true;
      }
    }
  }
  observePrompt({ turn, step, text: systemText, changed });
  assertVisibleLogged(session, systemText);
}

export function observePrompt(spec: { readonly turn: number; readonly step: number; readonly text: string; readonly changed: boolean }): void {
  if (process.env.X_HARNESS_ASSERT_VISIBLE !== "1") return;
  const fingerprint = createHash("sha256").update(spec.text).digest("hex").slice(0, 16);
  process.stderr.write(`[prompt] turn=${String(spec.turn)} step=${String(spec.step)} fingerprint=${fingerprint} changed=${String(spec.changed)}\n`);
}

export function assertVisibleLogged(session: Session, systemText: string): void {
  if (process.env.X_HARNESS_ASSERT_VISIBLE !== "1") return;
  const projected = session
    .deriveMessages()
    .filter((message) => message.role === "system")
    .map((message) => message.text)
    .join("\n");
  if (projected !== systemText) {
    throw new Error(`visible-logged invariant violated: system projection (${String(projected.length)} chars) != committed systemText (${String(systemText.length)} chars)`);
  }
}

export type DialStep =
  | { readonly kind: "dial"; readonly dial: Dial; readonly schemas: readonly import("@x-harness/tools").ToolSchema[] }
  | { readonly kind: "no-model" }
  | { readonly kind: "bad-dial" };

function isDialShape(value: unknown): value is Dial {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.model !== "string" || v.model === "") return false;
  if (v.provider !== undefined && typeof v.provider !== "string") return false;
  if (v.temperature !== undefined && typeof v.temperature !== "number") return false;
  if (v.maxTokens !== undefined && (typeof v.maxTokens !== "number" || !Number.isInteger(v.maxTokens))) return false;
  if (v.thinking !== undefined && !["off", "low", "medium", "high", "max"].includes(v.thinking as string)) return false;
  return true;
}

function appendContextIfShifted(session: Session, dial: Dial): void {
  if (dial.provider === undefined) return;
  const last = lastRequestContext(session.events());
  if (last?.provider !== dial.provider || last?.model !== dial.model) {
    appendEvent(session, "request/context", {
      provider: dial.provider,
      model: dial.model,
      ...(typeof dial.contextWindow === "number" && Number.isFinite(dial.contextWindow) && dial.contextWindow > 0 ? { contextWindow: dial.contextWindow } : {}),
    });
  }
}

export function dialFailure(kind: "no-model" | "bad-dial"): TurnOutcome {
  if (kind === "no-model") return { kind: "error", message: "no model configured", code: "no-model" };
  return { kind: "error", message: "agentRequest returned invalid dial", code: "bad-dial" };
}

export function fatalOutcome(controller: AbortController, cancelled: string | undefined, outcome: TurnOutcome): TurnOutcome {
  return controller.signal.aborted ? abortedOutcome(cancelled) : outcome;
}

export async function dialStep(scope: TurnScope, step: number): Promise<DialStep> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  const folded = foldDial(deps.options, session.events());
  if ("missing" in folded) return { kind: "no-model" };
  const dial = await deps.dispatchRequest({ session: session.id, turn, step, dial: folded, signal: controller.signal }, folded);
  if (!isDialShape(dial)) return { kind: "bad-dial" };
  const schemas = deps.tools.schemas({ sessionId: session.id });
  const toolRefs = toToolRefs(schemas);
  if (headerChanged(dial, toolRefs, session.events())) {
    appendEvent(session, "request/header", {
      model: dial.model,
      ...(dial.provider !== undefined ? { provider: dial.provider } : {}),
      ...(dial.temperature !== undefined ? { temperature: dial.temperature } : {}),
      ...(dial.maxTokens !== undefined ? { maxTokens: dial.maxTokens } : {}),
      ...(dial.thinking !== undefined ? { thinking: dial.thinking } : {}),
      tools: toolRefs,
    });
    appendContextIfShifted(session, dial);
  }
  return { kind: "dial", dial, schemas };
}

function truncatedToolContent(decision: unknown, base: string): string {
  if (typeof decision !== "object" || decision === null) return base;
  const asDecision = decision as { content?: unknown; note?: unknown };
  if (typeof asDecision.content === "string" && asDecision.content !== "") return asDecision.content;
  if (typeof asDecision.note === "string" && asDecision.note !== "") return `${base}\n${asDecision.note}`;
  return base;
}

async function pairTruncatedCalls(
  scope: TurnScope,
  at: { readonly turn: number; readonly step: number },
  calls: readonly ToolCallSpec[],
): Promise<void> {
  const { deps, controller } = scope;
  const session = deps.session;
  for (const call of calls) {
    const decision = controller.signal.aborted
      ? undefined
      : await deps.dispatchTruncatedTool({ session: session.id, turn: at.turn, step: at.step, callId: call.callId, name: call.name, arguments: call.arguments, signal: controller.signal });
    const content = controller.signal.aborted
      ? undefined
      : truncatedToolContent(decision, TRUNCATED_TOOL_MESSAGE);
    mustAppendPair(session, at, {
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      content: content ?? TRUNCATED_TOOL_MESSAGE,
    });
  }
}

export async function scheduleTools(scope: TurnScope, step: number, assistant: AssistantSettled): Promise<ToolFlow> {
  const { deps, controller, turn } = scope;
  const session = deps.session;
  let specs: ToolCallSpec[] = assistant.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({ callId: block.callId, name: block.name, arguments: block.input }));
  if (specs.length === 0) return { kind: "none", hasTools: false, truncatedCount: 0 };
  const specsTotal = specs.length;
  if (assistant.stopReason === "max-tokens") {
    const truncated: ToolCallSpec[] = [];
    const runnable: ToolCallSpec[] = [];
    for (const spec of specs) (isTruncatedArguments(spec.arguments) ? truncated : runnable).push(spec);
    await pairTruncatedCalls(scope, { turn, step }, truncated);
    if (runnable.length === 0) return { kind: "none", hasTools: false, truncatedCount: truncated.length };
    specs = runnable;
  }
  const collected = await executeToolCalls(
    {
      session,
      registry: deps.tools,
      signal: controller.signal,
      maxParallel: deps.options.maxParallelToolCalls,
      maxResultChars: deps.options.maxToolResultChars,
      turn,
      step,
      ...(deps.tools.restrictionOf(session.id) !== undefined
        ? { allowedTools: deps.tools.schemas({ sessionId: session.id }).map((schema) => schema.name) }
        : {}),
      ...(deps.emitToolStream !== undefined ? { emitToolStream: deps.emitToolStream } : {}),
    },
    specs,
  );
  for (const context of chunkContexts(collected.additionalContexts)) {
    appendEvent(session, "agent/inbox/spliced", insertData("next-step", context));
  }
  if (controller.signal.aborted) return { kind: "aborted" };
  return { kind: "ran", collected, hasTools: true, truncatedCount: assistant.stopReason === "max-tokens" ? specsTotal - specs.length : 0 };
}

interface ConcludeInput {
  readonly current: TurnOutcome | undefined;
  readonly flow: ToolFlow;
  readonly assistant: AssistantSettled;
  readonly pendingConclude: boolean;
  readonly session: Session;
}

export function settleConclude(input: ConcludeInput): { readonly turnEnds: TurnOutcome | undefined; readonly pendingConclude: boolean } {
  const { current, flow, assistant, pendingConclude, session } = input;
  let next: TurnOutcome | undefined;
  let pending = pendingConclude;
  if (flow.kind === "ran") {
    const collected = flow.collected;
    pending = false;
    if (collected.concludesTurn && collected.additionalContexts.length === 0) next = { kind: "completed" };
    if (collected.concludesTurn && collected.additionalContexts.length > 0) pending = true;
  } else if (assistant.stopReason === "stop") {
    next = { kind: "completed" };
  }
  let turnEnds = current;
  if (next !== undefined) turnEnds = mergeOutcome(current, next);
  if (turnEnds === undefined && pending && foldInbox(session.events()).nextStep.length === 0) turnEnds = { kind: "completed" };
  return { turnEnds, pendingConclude: pending };
}

async function stoppingResumes(scope: TurnScope): Promise<boolean> {
  const { deps, controller, turn } = scope;
  if (foldInbox(deps.session.events()).nextStep.length > 0) return true;
  await deps.dispatchTurnStopping({ session: deps.session.id, turn, signal: controller.signal });
  return foldInbox(deps.session.events()).nextStep.length > 0;
}

export async function maybeResume(scope: TurnScope, turnEnds: TurnOutcome | undefined): Promise<TurnOutcome | undefined> {
  if (turnEnds?.kind !== "completed") return turnEnds;
  return (await stoppingResumes(scope)) ? undefined : turnEnds;
}


function isRewrittenEntries(value: unknown): value is readonly InboxEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as InboxEntry).id === "string" && Array.isArray((entry as InboxEntry).content));
}

function isEnterDecision(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["kind"] === "enter";
}

function chunkContexts(contexts: readonly ContentBlock[]): ContentBlock[][] {
  return contexts.map((block) => [block]);
}
