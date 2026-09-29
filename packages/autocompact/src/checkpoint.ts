import type { LlmRuntime } from "@x-harness/llm";
import type { Session, SessionEvent, SessionId, SurfaceNode } from "@x-harness/session";
import { anchorIndexOf } from "@x-harness/session";
import {
  accumulateFileOps,
  capSerializedConversation,
  computeFileLists,
  DEFAULT_FILE_TOOLS,
  formatFileOperations,
  isTurnStartNode,
  neutralizeLineStarts,
  nodeTokens,
  runTextRequest,
  serializeConversation,
  type FileToolNames,
  type SummarizerFace,
} from "@x-harness/compaction";
import { WIDE_TOKENS_PER_CHAR } from "@x-harness/token-meter";
import { emptyLedger, mergeLedger, parseLedgerPatch, serializeLedger, serializeLedgerForPrompt, trimLedgerWithFiles, ledgerReady, type Ledger } from "./ledger.ts";
import { SUMMARIZER_RESERVE_CAP } from "./lines.ts";
import { lastTurnStartIndex } from "./scavenger.ts";
import type { CheckpointAction } from "./tokens.ts";

export const CP_SYSTEM_PROMPT =
  "You are a context ledger maintenance assistant. You update a structured working ledger for an ongoing engineering session. Output ONLY the updated ledger sections in the exact tag format requested. Do NOT continue the conversation. Do NOT answer any questions in the conversation.";

export const CP_UPDATE_PROMPT = `The <ledger> above is the current working ledger. The <new-segment> contains the latest conversation messages not yet incorporated into it.

Update the ledger with the new segment. RULES:
- goals: user intents and objectives; append or refine, never drop an existing goal line
- decisions: settled design decisions; append-only; to overturn an earlier decision, add a new line that says which earlier line it supersedes
- done: completed tasks; a pending line that is now complete moves here verbatim
- pending: open tasks; remove lines that moved to done
- verified: facts confirmed by evidence in the conversation
- unverified: assumptions not yet confirmed; move a line to verified once evidence appears
- current: the work in progress right now and the immediate next step (rewritten each time)

Output ALL seven sections with these exact tags:
<goals>...</goals>
<decisions>...</decisions>
<done>...</done>
<pending>...</pending>
<verified>...</verified>
<unverified>...</unverified>
<current>...</current>

Keep each line concise. Preserve exact file paths, function names, and error messages.`;

export interface CheckpointConfig {
  readonly ledgerBudgetTokens: number;
  readonly checkpointMaxRetries: number;
  readonly checkpointIdleTimeoutMs: number;
}

export interface CheckpointJob {
  readonly startSeq: number;
  readonly segmentFromSeq: number;
  segmentFrom: number;
  retries: number;
  readonly turn: number;
  readonly step: number;
  readonly controller: AbortController;
  done: Promise<void>;
  boxedEnd: number | undefined;
}

export interface CheckpointState {
  ledger: Ledger;
  coveredSeq: number;
  armed: boolean;
  consecutiveFailures: number;
  broken: boolean;
  job: CheckpointJob | undefined;
}

export function emptyCheckpointState(): CheckpointState {
  return { ledger: emptyLedger(), coveredSeq: -1, armed: true, consecutiveFailures: 0, broken: false, job: undefined };
}

export interface CheckpointDeps {
  readonly llm: LlmRuntime;
  readonly face: SummarizerFace;
  readonly session: Session;
  readonly config: CheckpointConfig;
  readonly fileTools: FileToolNames;
  readonly warn: (session: SessionId, code: string, detail?: Record<string, unknown>) => void;
  readonly emit: (action: CheckpointAction, detail?: Record<string, unknown>) => void;
}

export function checkpointMaxChars(face: SummarizerFace, ledgerChars: number): number | undefined {
  const budget = face.contextWindow - Math.min(face.maxOutputTokens, 20_000) - 4_000 - ledgerChars;
  return budget >= 1 ? Math.floor(budget / WIDE_TOKENS_PER_CHAR) : undefined;
}

export function boxSegment(fields: {
  readonly nodes: readonly SurfaceNode[];
  readonly from: number;
  readonly lastTurnStart: number;
  readonly tokenBudget: number;
}): { readonly start: number; readonly end: number } | undefined {
  const { nodes, tokenBudget } = fields;
  const end = Math.min(fields.lastTurnStart, nodes.length);
  if (end <= fields.from) return undefined;
  let acc = 0;
  let start = end;
  for (let i = end - 1; i >= fields.from; i -= 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const tokens = nodeTokens(node);
    if (acc + tokens > tokenBudget && start < end) break;
    acc += tokens;
    if (isTurnStartNode(node)) start = i;
  }
  if (start >= end) return undefined;
  return { start, end };
}

export function filesTextOf(segment: readonly SurfaceNode[]): string {
  const ops = accumulateFileOps(segment, { readFiles: [], modifiedFiles: [] }, DEFAULT_FILE_TOOLS);
  const lists = computeFileLists(ops);
  return formatFileOperations(lists.readFiles, lists.modifiedFiles).trim();
}

export function maybeStartCheckpoint(fields: {
  readonly state: CheckpointState;
  readonly deps: CheckpointDeps;
  readonly stepSignal: AbortSignal;
  readonly lastTurnStart: number;
  readonly turn: number;
  readonly step: number;
}): boolean {
  const { state, deps } = fields;
  if (state.broken || state.job !== undefined) return false;
  const nodes = deps.session.surface();
  const from = firstUncoveredIndex(state, nodes);
  if (fields.lastTurnStart <= from) return false;
  const controller = new AbortController();
  const onStepAbort = (): void => controller.abort();
  if (fields.stepSignal.aborted) controller.abort();
  else fields.stepSignal.addEventListener("abort", onStepAbort, { once: true });
  const fromSeq = nodes[from - 1] !== undefined ? (nodes[from - 1] as SurfaceNode).seq : -1;
  const job: CheckpointJob = {
    startSeq: deps.session.events().length,
    segmentFromSeq: fromSeq,
    segmentFrom: from,
    retries: 0,
    turn: fields.turn,
    step: fields.step,
    controller,
    done: Promise.resolve(),
    boxedEnd: undefined,
  };
  state.job = job;
  job.done = runCheckpoint({ state, job, deps }).finally(() => {
    if (state.job === job) state.job = undefined;
    fields.stepSignal.removeEventListener("abort", onStepAbort);
  });
  deps.emit("started", { segmentFrom: job.segmentFrom });
  return true;
}

export function cancelJob(state: CheckpointState): void {
  const job = state.job;
  if (job === undefined) return;
  state.job = undefined;
  job.controller.abort();
}

export async function joinInflight(fields: { readonly state: CheckpointState; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<boolean> {
  const job = fields.state.job;
  if (job === undefined) return ledgerReady(fields.state.ledger) && !fields.state.broken;
  if (fields.signal?.aborted) return ledgerReady(fields.state.ledger) && !fields.state.broken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, fields.timeoutMs);
    onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    fields.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([job.done, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) fields.signal?.removeEventListener("abort", onAbort);
  }
  return ledgerReady(fields.state.ledger) && !fields.state.broken;
}

export function firstUncoveredIndex(state: CheckpointState, nodes: readonly SurfaceNode[]): number {
  for (const [i, node] of nodes.entries()) {
    if (node.seq === state.coveredSeq) return i + 1;
  }
  for (const [i, node] of nodes.entries()) {
    if (node.seq > state.coveredSeq) return i;
  }
  return nodes.length;
}

export function conservativeBoundarySeq(nodes: readonly SurfaceNode[]): number {
  const anchor = anchorIndexOf(nodes);
  const from = anchor < 0 ? 1 : anchor + 1;
  for (let i = from; i < nodes.length; i += 1) {
    if (isTurnStartNode(nodes[i] as SurfaceNode)) return (nodes[i - 1] as SurfaceNode).seq;
  }
  return nodes.length > 0 ? (nodes[nodes.length - 1] as SurfaceNode).seq : -1;
}

async function runCheckpoint(fields: { readonly state: CheckpointState; readonly job: CheckpointJob; readonly deps: CheckpointDeps }): Promise<void> {
  const { state, job, deps } = fields;
  try {
    for (;;) {
      const patch = await callCheckpointModel({ state, job, deps });
      if (patch === undefined) return;
      const nodes = deps.session.surface();
      if (jobInvalidated(deps.session.events(), job)) {
        job.segmentFrom = Math.min(job.segmentFrom, nodes.length);
        const anchorGone = job.segmentFromSeq >= 0 && nodes.every((node) => node.seq !== job.segmentFromSeq);
        if (nodes.length <= job.segmentFrom || anchorGone) {
          state.coveredSeq = Math.min(state.coveredSeq, conservativeBoundarySeq(nodes));
          deps.emit("reanchored", { segmentFrom: job.segmentFrom });
          return;
        }
        if (job.retries >= deps.config.checkpointMaxRetries) {
          acceptPatch({ state, job, deps, patch, stale: true });
          return;
        }
        const anchorIndex = nodes.findIndex((node) => node.seq === job.segmentFromSeq);
        if (anchorIndex >= 0) job.segmentFrom = anchorIndex;
        job.retries += 1;
        deps.emit("invalidated-retry", { retries: job.retries });
        continue;
      }
      acceptPatch({ state, job, deps, patch, stale: false });
      return;
    }
  } catch (error) {
    if (job.controller.signal.aborted) return;
    deps.warn(deps.session.id, "checkpoint-failed", { error: error instanceof Error ? error.message : String(error) });
    failOnce(state, deps);
  }
}

function jobInvalidated(events: readonly SessionEvent[], job: CheckpointJob): boolean {
  for (let i = job.startSeq; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") return true;
  }
  return false;
}

async function callCheckpointModel(fields: {
  readonly state: CheckpointState;
  readonly job: CheckpointJob;
  readonly deps: CheckpointDeps;
}): Promise<Ledger | undefined> {
  const { state, job, deps } = fields;
  const nodes = deps.session.surface();
  job.boxedEnd = undefined;
  const ledgerText = serializeLedger(state.ledger);
  const maxChars = checkpointMaxChars(deps.face, ledgerText.length);
  if (maxChars === undefined) {
    deps.warn(deps.session.id, "checkpoint-failed", { reason: "cp-input-budget-exhausted" });
    deps.emit("failed", { reason: "cp-input-budget-exhausted" });
    failOnce(state, deps);
    return undefined;
  }
  const lastStart = lastTurnStartIndex(nodes);
  const boxed = boxSegment({
    nodes,
    from: job.segmentFrom,
    lastTurnStart: lastStart < 0 ? nodes.length : lastStart,
    tokenBudget: Math.max(1, Math.floor(maxChars / 4)),
  });
  if (boxed === undefined) {
    failOnce(state, deps);
    return undefined;
  }
  const segment = nodes.slice(boxed.start, boxed.end);
  const segmentText = neutralizeLineStarts(capSerializedConversation(serializeConversation(segment), maxChars));
  job.boxedEnd = boxed.end;
  const prompt = `<ledger>\n${serializeLedgerForPrompt(state.ledger)}\n</ledger>\n\n<new-segment>\n${segmentText}\n</new-segment>\n\n${CP_UPDATE_PROMPT}`;
  const outcome = await runTextRequest({
    llm: deps.llm,
    face: { ...deps.face, maxOutputTokens: Math.min(deps.face.maxOutputTokens, SUMMARIZER_RESERVE_CAP) },
    system: CP_SYSTEM_PROMPT,
    prompt,
    idleTimeoutMs: deps.config.checkpointIdleTimeoutMs,
    signal: job.controller.signal,
  });
  if (job.controller.signal.aborted) return undefined;
  if (!outcome.ok) {
    if (outcome.reason === "failed") deps.warn(deps.session.id, "checkpoint-failed", { reason: "provider-error" });
    else if (outcome.reason === "truncated") deps.warn(deps.session.id, "checkpoint-failed", { reason: "ledger-output-truncated" });
    failOnce(state, deps);
    return undefined;
  }
  const patch = parseLedgerPatch(outcome.text);
  if (patch === undefined) {
    deps.warn(deps.session.id, "checkpoint-failed", { reason: "ledger-patch-unparsable" });
    failOnce(state, deps);
  }
  return patch;
}

function acceptPatch(fields: {
  readonly state: CheckpointState;
  readonly job: CheckpointJob;
  readonly deps: CheckpointDeps;
  readonly patch: Ledger;
  readonly stale: boolean;
}): void {
  const { state, job, deps, patch, stale } = fields;
  state.ledger = trimLedgerWithFiles(mergeLedger(state.ledger, patch), deps.config.ledgerBudgetTokens).ledger;
  const nodes = deps.session.surface();
  const boundaryNode = job.boxedEnd !== undefined ? nodes[job.boxedEnd - 1] : nodes[nodes.length - 1];
  const newCovered = boundaryNode !== undefined ? boundaryNode.seq : state.coveredSeq;
  state.coveredSeq = Math.max(state.coveredSeq, newCovered);
  state.consecutiveFailures = 0;
  const recorded = deps.session.append("autocompact/checkpoint", {
    turn: job.turn,
    step: job.step,
    ledger: serializeLedger(state.ledger),
    coveredSeq: state.coveredSeq,
    ...(stale ? { stale: true } : {}),
  });
  if (!recorded.ok) {
    deps.emit("failed", { failures: state.consecutiveFailures + 1, reason: `append-failed:${recorded.reason}` });
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= 3) {
      deps.emit("breaker", { failures: state.consecutiveFailures });
    }
    return;
  }
  deps.emit(stale ? "stale-accepted" : "advanced", { coveredSeq: state.coveredSeq });
}

function failOnce(state: CheckpointState, deps: CheckpointDeps): void {
  state.consecutiveFailures += 1;
  deps.emit("failed", { failures: state.consecutiveFailures });
  if (state.consecutiveFailures < 3) return;
  state.broken = true;
  deps.emit("breaker", { failures: state.consecutiveFailures });
}

export function foldCheckpointEvents(events: readonly SessionEvent[]): { readonly ledger: Ledger; readonly coveredSeq: number } {
  const result = { ledger: emptyLedger(), coveredSeq: -1 };
  for (const event of events) {
    if (event.type !== "autocompact/checkpoint") continue;
    const data = event.data as { ledger?: unknown; coveredSeq?: unknown };
    if (typeof data.ledger !== "string" || typeof data.coveredSeq !== "number" || !Number.isFinite(data.coveredSeq)) continue;
    const ledger = parseLedgerPatch(data.ledger);
    if (ledger === undefined) continue;
    result.ledger = ledger;
    result.coveredSeq = Math.max(-1, Math.floor(data.coveredSeq));
  }
  return result;
}
