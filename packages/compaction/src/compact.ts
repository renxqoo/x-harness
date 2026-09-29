import type { LlmRuntime } from "@x-harness/llm";
import { anchorIndexOf } from "@x-harness/session";
import type { SessionId, SessionStore, SurfaceNode } from "@x-harness/session";
import { estimateText } from "@x-harness/token-meter";
import { findCutPoint, USER_QUOTE_TOKENS } from "./cut.ts";
import { lastWindow } from "./occupancy.ts";
import {
  accumulateFileOps,
  computeFileLists,
  formatFileOperations,
  hasPathBearingToolUse,
  parseFileOperations,
  type FileToolNames,
} from "./file-ops.ts";
import { AUTO_CONTINUATION_NOTE } from "./prompts.ts";
import { serializeConversation } from "./serialize.ts";
import { summarize, type SummarizerFace, type SummarizeOutcome } from "./summarize.ts";

export type CompactTrigger = "manual" | "auto" | "emergency";

export type CompactionSkipReason =
  | "session-unknown"
  | "summarizer-unconfigured"
  | "llm-unavailable"
  | "no-cut-point"
  | "summary-input-budget-exhausted"
  | "summarize-failed"
  | "summary-truncated"
  | "summary-empty"
  | "replace-failed"
  | "aborted";

export type CompactionResult =
  | { readonly ok: true; readonly replacedNodes: number; readonly summaryTokens: number }
  | { readonly ok: false; readonly reason: CompactionSkipReason };

export interface ResolvedConfig {
  readonly contextWindow: number;
  readonly triggerPct: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly keepMinTurns: number;
  readonly fileTools: FileToolNames;
  readonly idleTimeoutMs: number;
  readonly summarizer: SummarizerFace | undefined;
  readonly customInstructions?: string;
}

export interface CompactFields {
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly customInstructions?: string;
  readonly keepRecentTokens?: number;
  readonly keepMinTurns?: number;
  readonly turn: number;
  readonly step: number;
  readonly signal?: AbortSignal;
}

export interface LandedPayload {
  readonly session: SessionId;
  readonly trigger: CompactTrigger;
  readonly replacedNodes: number;
  readonly summaryTokens: number;
}

export interface CompactDeps {
  readonly store: SessionStore;
  readonly llm: LlmRuntime | undefined;
  readonly config: ResolvedConfig;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly landed: (payload: LandedPayload) => void;
  readonly inflight: Map<SessionId, Flight>;
  readonly epochs: Map<SessionId, number>;
}

const OUTCOME_REASONS: Readonly<Record<Exclude<SummarizeOutcome, { ok: true }>["reason"], CompactionSkipReason>> = {
  "budget-exhausted": "summary-input-budget-exhausted",
  empty: "summary-empty",
  failed: "summarize-failed",
  truncated: "summary-truncated",
  aborted: "aborted",
};

export function previousSummaryOf(nodes: readonly SurfaceNode[]): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node === undefined || node.event.type !== "user/message") continue;
    const op = node.event.surfaceOp;
    if (typeof op !== "object" || op === null) continue;
    for (const block of node.event.data.content) {
      if (block.type === "text") return block.text;
    }
    return "";
  }
  return undefined;
}

export interface Flight {
  readonly epoch: number;
  readonly promise: Promise<CompactionResult>;
}

export function runCompact(deps: CompactDeps, fields: CompactFields): Promise<CompactionResult> {
  const session = deps.store.get(fields.session);
  if (session === undefined) return Promise.resolve({ ok: false, reason: "session-unknown" });
  const epoch = deps.epochs.get(fields.session) ?? 0;
  const existing = deps.inflight.get(fields.session);
  if (existing !== undefined && existing.epoch === epoch) return existing.promise;
  const promise = compactSession(deps, fields, { epoch, nodes: session.surface() }).finally(() => {
    const current = deps.inflight.get(fields.session);
    if (current !== undefined && current.promise === promise) {
      deps.inflight.delete(fields.session);
      if (deps.store.get(fields.session) === undefined) deps.epochs.delete(fields.session);
    }
  });
  deps.inflight.set(fields.session, { epoch, promise });
  return promise;
}

interface Span {
  readonly nodes: readonly SurfaceNode[];
  readonly previousSummary: string | undefined;
}

function fileListsOf(deps: CompactDeps, session: SessionId, span: Span) {
  const previousLists =
    span.previousSummary !== undefined ? parseFileOperations(span.previousSummary) : { readFiles: [], modifiedFiles: [] };
  const lists = computeFileLists(accumulateFileOps(span.nodes, previousLists, deps.config.fileTools));
  if (lists.readFiles.length === 0 && lists.modifiedFiles.length === 0 && hasPathBearingToolUse(span.nodes)) {
    deps.warn(session, "file-ledger-empty");
  }
  return lists;
}

interface SummarizeCall {
  readonly deps: CompactDeps;
  readonly fields: CompactFields;
  readonly span: Span;
  readonly face: SummarizerFace;
  readonly llm: LlmRuntime;
}

function focusOf(deps: CompactDeps, fields: CompactFields): string | undefined {
  if (fields.customInstructions !== undefined) return fields.customInstructions;
  return deps.config.customInstructions;
}

async function summarizeSpan(call: SummarizeCall): Promise<SummarizeOutcome> {
  const { deps, fields, span, face, llm } = call;
  const focus = focusOf(deps, fields);
  return summarize({
    llm,
    face,
    reserveTokens: deps.config.reserveTokens,
    conversation: serializeConversation(span.nodes),
    ...(span.previousSummary !== undefined ? { previousSummary: span.previousSummary } : {}),
    ...(focus !== undefined ? { customInstructions: focus } : {}),
    signal: fields.signal ?? new AbortController().signal,
    idleTimeoutMs: deps.config.idleTimeoutMs,
  });
}

function warnOutcome(deps: CompactDeps, session: SessionId, outcome: Exclude<SummarizeOutcome, { ok: true }>): void {
  switch (outcome.reason) {
    case "failed":
      deps.warn(session, "summarize-failed");
      break;
    case "truncated":
      deps.warn(session, "summary-truncated");
      break;
    case "empty":
      deps.warn(session, "summarize-failed", { reason: "empty-summary" });
      break;
    case "budget-exhausted":
      deps.warn(session, "summary-input-budget-exhausted");
      break;
    default:
      break;
  }
}

interface LandingCall {
  readonly deps: CompactDeps;
  readonly fields: CompactFields;
  readonly nodes: readonly SurfaceNode[];
  readonly start: number;
  readonly end: number;
  readonly summary: string;
  readonly epoch: number;
}

function landSummary(call: LandingCall): CompactionResult {
  const { deps, fields, nodes, start, end, summary, epoch } = call;
  if ((deps.epochs.get(fields.session) ?? 0) !== epoch) return { ok: false, reason: "session-unknown" };
  const session = deps.store.get(fields.session);
  if (session === undefined) return { ok: false, reason: "session-unknown" };
  const appended = session.append(
    "user/message",
    { turn: fields.turn, step: fields.step, content: [{ type: "text", text: summary }] },
    { surfaceOp: { op: "replace", startSeq: nodes[start]?.seq ?? -1, endSeq: nodes[end]?.seq ?? -1 } },
  );
  if (!appended.ok) return { ok: false, reason: "replace-failed" };
  const replacedNodes = end - start + 1;
  const summaryTokens = estimateText(summary);
  deps.landed({ session: fields.session, trigger: fields.trigger, replacedNodes, summaryTokens });
  return { ok: true, replacedNodes, summaryTokens };
}

async function compactSession(
  deps: CompactDeps,
  fields: CompactFields,
  leg: { readonly epoch: number; readonly nodes: readonly SurfaceNode[] },
): Promise<CompactionResult> {
  const { epoch, nodes } = leg;
  const quote = fields.trigger === "emergency" ? 0 : USER_QUOTE_TOKENS;
  const keep = fields.keepRecentTokens ?? deps.config.keepRecentTokens;
  const served = lastWindow(deps.store.get(fields.session)?.events() ?? []) ?? deps.config.contextWindow;
  const effectiveWindow = Math.min(deps.config.contextWindow, served);
  const start = anchorIndexOf(nodes) + 1;
  const cut = findCutPoint(nodes, keep, {
    userQuoteTokens: quote,
    protectedHead: start,
    ...(fields.trigger !== "emergency" ? { keepMinTurns: fields.keepMinTurns ?? deps.config.keepMinTurns, windowCapTokens: Math.floor(effectiveWindow * 0.25) } : {}),
  });
  if (cut === undefined) return { ok: false, reason: "no-cut-point" };

  const end = cut.cut - 1;

  const face = deps.config.summarizer;
  if (face === undefined) {
    deps.warn(fields.session, "summarizer-unconfigured");
    return { ok: false, reason: "summarizer-unconfigured" };
  }
  const llm = deps.llm;
  if (llm === undefined) {
    deps.warn(fields.session, "summarize-failed", { reason: "llm-unavailable" });
    return { ok: false, reason: "llm-unavailable" };
  }

  const previousSummary = previousSummaryOf(nodes);
  const span: Span = { nodes: nodes.slice(start, cut.cut), previousSummary };
  const lists = fileListsOf(deps, fields.session, span);
  const outcome = await summarizeSpan({ deps, fields, span, face, llm });
  if (!outcome.ok) {
    warnOutcome(deps, fields.session, outcome);
    return { ok: false, reason: OUTCOME_REASONS[outcome.reason] };
  }

  const tail = formatFileOperations(lists.readFiles, lists.modifiedFiles);
  const note = fields.trigger === "manual" ? "" : `\n\n${AUTO_CONTINUATION_NOTE}`;
  return landSummary({ deps, fields, nodes, start, end, summary: `${outcome.text}${tail}${note}`, epoch });
}
