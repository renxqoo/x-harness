import type { AgentMessageKind, ContentBlock, ImageBlock, InboxEntry, Session, SessionId } from "@x-harness/session";
import { agentMessageData, AGENT_MESSAGE_KINDS } from "@x-harness/session";
import { errorText } from "@x-harness/core";
import { foldInbox, insertData } from "./inbox.ts";
import { concludeWindow } from "./continuation.ts";
import { runAttempt } from "./attempt.ts";
import type { AttemptResult } from "./attempt.ts";
import {
  anchorSystem,
  appendEvent,
  appendSurfaceEvent,
  beginStep,
  concludeStepEntry,
  dialFailure,
  dialStep,
  fatalOutcome,
  maybeResume,
  mergeOutcome,
  abortedOutcome,
  scheduleTools,
  settleConclude,
} from "./step.ts";
import type { AssistantSettled, DriverDeps, ResolvedOptions, StepEntry, TurnOutcome, TurnScope } from "./step.ts";

export type { DriverDeps, ResolvedOptions };

function entryOutcome(entry: StepEntry): TurnOutcome | undefined {
  if (entry.kind === "empty") return { kind: "completed" };
  if (entry.kind === "blocked") return { kind: "blocked", ...(entry.reason !== undefined ? { reason: entry.reason } : {}) };
  return undefined;
}

function appendUserBatch(scope: TurnScope, step: number, entry: StepEntry): void {
  const { deps, turn } = scope;
  if (entry.kind !== "enter" || entry.entries.length === 0) return;
  const session = deps.session;
  let plain: ContentBlock[] = [];
  const flushPlain = (): void => {
    if (plain.length === 0) return;
    appendSurfaceEvent(session, { type: "user/message", data: { turn, step, content: plain }, surfaceOp: "append" });
    plain = [];
  };
  for (const item of entry.entries) {
    if (item.origin === undefined) {
      plain = [...plain, ...item.content];
      continue;
    }
    flushPlain();
    appendSurfaceEvent(session, {
      type: "agent/message",
      data: agentMessageData({ turn, step, source: item.origin.source, kind: item.origin.kind, content: item.content }),
      surfaceOp: "append",
    });
  }
  flushPlain();
}

export function chainsNextTurn(cancelled: string | undefined, turnEnds: TurnOutcome | undefined, session: Session): boolean {
  if (cancelled !== undefined) return false;
  if (turnEnds !== undefined && turnEnds.kind !== "completed") return false;
  const inbox = foldInbox(session.events());
  return inbox.nextTurn.length > 0 || inbox.nextStep.length > 0;
}

function closeOpenStep(session: Session, turnNumber: number, openStep: number): void {
  if (openStep < 0) return;
  try {
    appendEvent(session, "step/end", { turn: turnNumber, step: openStep });
  } catch {
  }
}

interface TurnState {
  turnEnds: TurnOutcome | undefined;
  pendingConclude: boolean;
  openStep: number;
}

function attemptAftermath(spec: {
  readonly scope: TurnScope;
  readonly state: TurnState;
  readonly turn: number;
  readonly step: number;
  readonly attempt: AttemptResult;
  readonly cancelled: string | undefined;
}): { readonly kind: "break" } | { readonly kind: "continue" } | { readonly kind: "ok"; readonly message: AssistantSettled } {
  const { scope, state, turn, step, attempt, cancelled } = spec;
  if (attempt.kind === "fatal") {
    closeStepOutcome({ session: scope.deps.session, state, turn, step }, fatalOutcome(scope.controller, cancelled, attempt.outcome));
    return { kind: "break" };
  }
  if (attempt.kind === "continue") return { kind: "continue" };
  if (attempt.message.interrupted === true) {
    closeStepOutcome({ session: scope.deps.session, state, turn, step }, abortedOutcome(cancelled));
    return { kind: "break" };
  }
  return { kind: "ok", message: attempt.message };
}

function closeStepOutcome(spec: { readonly session: Session; readonly state: TurnState; readonly turn: number; readonly step: number }, outcome: TurnOutcome): void {
  spec.state.turnEnds = mergeOutcome(spec.state.turnEnds, outcome);
  appendEvent(spec.session, "step/end", { turn: spec.turn, step: spec.step });
  spec.state.openStep = -1;
}

type StepFlow = { readonly kind: "resume" } | { readonly kind: "break" } | { readonly kind: "loop" };

interface ConcludeStepSpec {
  readonly scope: TurnScope;
  readonly turn: number;
  readonly step: number;
  readonly state: TurnState;
  readonly assistant: AssistantSettled;
  readonly cancelled: string | undefined;
}

async function enterStep(spec: { readonly scope: TurnScope; readonly step: number; readonly continuationStep: boolean; readonly state: TurnState }): Promise<StepEntry | undefined> {
  const entry = spec.continuationStep ? await concludeStepEntry(spec.scope, spec.step) : await beginStep(spec.scope, spec.step, spec.step === 0);
  const early = entryOutcome(entry);
  if (early !== undefined) {
    spec.state.turnEnds = mergeOutcome(spec.state.turnEnds, early);
    return undefined;
  }
  return entry;
}

async function concludeStep(spec: ConcludeStepSpec): Promise<StepFlow> {
  const { scope, turn, step, state, assistant, cancelled } = spec;
  const { deps, controller } = scope;
  const session = deps.session;
  const tools = await scheduleTools(scope, step, assistant);
  if (tools.kind === "aborted") {
    closeStepOutcome({ session, state, turn, step }, abortedOutcome(cancelled));
    return { kind: "break" };
  }
  const concludeWindowDue = tools.kind === "none" || (tools.kind === "ran" && assistant.stopReason === "max-tokens");
  if (concludeWindowDue) {
    const flow = await concludeWindow(scope, step, { assistant, hasTools: tools.hasTools, truncatedCount: tools.truncatedCount });
    if (flow.kind === "resume") {
      appendEvent(session, "step/end", { turn, step });
      state.openStep = -1;
      return { kind: "resume" };
    }
    if (flow.kind === "fail") {
      appendEvent(session, "step/end", { turn, step });
      state.openStep = -1;
      state.turnEnds = mergeOutcome(state.turnEnds, fatalOutcome(controller, cancelled, { kind: "error", message: flow.message, code: flow.code }));
      return { kind: "break" };
    }
    if (flow.sticky) state.turnEnds = mergeOutcome(state.turnEnds, { kind: "max-tokens" });
  }
  const settled = settleConclude({ current: state.turnEnds, flow: tools, assistant, pendingConclude: state.pendingConclude, session });
  state.turnEnds = settled.turnEnds;
  state.pendingConclude = settled.pendingConclude;
  appendEvent(session, "step/end", { turn, step });
  state.openStep = -1;
  state.turnEnds = await maybeResume(scope, state.turnEnds);
  return state.turnEnds !== undefined ? { kind: "break" } : { kind: "loop" };
}

function userBlocks(text: string, options: { images?: readonly ImageBlock[] } | undefined) {
  const images = Array.isArray(options?.images)
    ? options.images.filter((block) => block?.type === "image" && typeof block.data === "string" && typeof block.mediaType === "string")
    : [];
  return [{ type: "text" as const, text }, ...images];
}

function turnEndData(turn: number, reason: TurnOutcome): Record<string, unknown> {
  if (reason.kind === "aborted") {
    return { turn, reason: { kind: "aborted", ...(reason.cause !== "" ? { cause: reason.cause } : {}) } };
  }
  if (reason.kind === "error") {
    return { turn, reason: { kind: "error", message: reason.message, ...(reason.code !== undefined ? { code: reason.code } : {}) } };
  }
  if (reason.kind === "blocked") {
    return { turn, reason: { kind: "blocked", ...(reason.reason !== undefined && reason.reason !== "" ? { reason: reason.reason } : {}) } };
  }
  return { turn, reason: { kind: reason.kind } };
}

export function createDriver(deps: DriverDeps): {
  readonly followup: (text: string, options?: { images?: readonly ImageBlock[] }) => void;
  readonly steer: (text: string, options?: { images?: readonly ImageBlock[] }) => void;
  readonly notify: (source: string, kind: AgentMessageKind, text: string) => void;
  readonly cancel: (cause: string, options?: { keepInbox?: boolean }) => void;
  readonly whenIdle: () => Promise<void>;
  readonly status: () => "idle" | "running";
} {
  const session = deps.session;
  let phase: { abort: AbortController; turn: number } | undefined;
  let wakeRequested = false;
  let cancelled: string | undefined;
  let idle: Array<() => void> = [];
  const failedTurnRef = { turn: 0 };

  const wake = (): void => {
    if (phase !== undefined) {
      wakeRequested = true;
      return;
    }
    void kick();
  };

  const notifyIdle = (): void => {
    if (phase !== undefined) return;
    for (const resolve of idle) resolve();
    idle = [];
  };

  async function kick(): Promise<void> {
    if (phase !== undefined) return;
    cancelled = undefined;
    deps.emitStatus("running");
    try {
      while (cancelled === undefined && (await turn())) {
      }
    } catch (error) {
      deps.emitError(failedTurnRef.turn, errorText(error));
    } finally {
      phase = undefined;
      const replay = wakeRequested && cancelled === undefined && foldInbox(session.events()).nextTurn.length > 0;
      wakeRequested = false;
      if (replay) {
        void kick();
      } else {
        deps.emitStatus("idle");
        notifyIdle();
      }
    }
  }

  async function turn(): Promise<boolean> {
    if (cancelled !== undefined) return false;
    const controller = new AbortController();
    const turnNumber = nextTurnNumber();
    failedTurnRef.turn = turnNumber;
    const scope: TurnScope = { deps, controller, turn: turnNumber };
    phase = { abort: controller, turn: turnNumber };
    const state: TurnState = { turnEnds: undefined, pendingConclude: false, openStep: -1 };
    try {
      appendEvent(session, "turn/start", { turn: turnNumber });
      let continuationStep = false;
      for (let step = 0; ; step++) {
        if (controller.signal.aborted) {
          state.turnEnds = mergeOutcome(state.turnEnds, abortedOutcome(cancelled));
          break;
        }
        const entry = await enterStep({ scope, step, continuationStep, state });
        if (entry === undefined) break;
        appendEvent(session, "step/start", { turn: turnNumber, step });
        state.openStep = step;
        anchorSystem(scope, step);
        const isContinuationStep = continuationStep;
        continuationStep = false;
        if (!isContinuationStep) appendUserBatch(scope, step, entry);
        const dialed = await dialStep(scope, step);
        if (dialed.kind !== "dial") {
          closeStepOutcome({ session, state, turn: turnNumber, step }, dialFailure(dialed.kind));
          break;
        }
        const attempt = await runAttempt({ scope, dial: dialed.dial, schemas: dialed.schemas, step });
        const aftermath = attemptAftermath({ scope, state, turn: turnNumber, step, attempt, cancelled });
        if (aftermath.kind === "break") break;
        if (aftermath.kind === "continue") {
          appendEvent(session, "step/end", { turn: turnNumber, step });
          state.openStep = -1;
          continue;
        }
        const flow = await concludeStep({ scope, turn: turnNumber, step, state, assistant: aftermath.message, cancelled });
        if (flow.kind === "resume") {
          continuationStep = true;
          continue;
        }
        if (flow.kind === "break") break;
      }
    } catch (error) {
      state.turnEnds = mergeOutcome(state.turnEnds, { kind: "error", message: errorText(error) });
      closeOpenStep(session, turnNumber, state.openStep);
    } finally {
      const reason = state.turnEnds ?? { kind: "completed" as const };
      try {
        appendEvent(session, "turn/end", turnEndData(turnNumber, reason));
      } catch {
        deps.emitError(turnNumber, "turn/end append failed");
      }
      if (reason.kind === "error") deps.emitError(turnNumber, reason.message);
    }
    return chainsNextTurn(cancelled, state.turnEnds, session);
  }

  function nextTurnNumber(): number {
    let max = -1;
    for (const event of session.events()) {
      if (event.type === "turn/start" && event.data.turn > max) max = event.data.turn;
    }
    return max + 1;
  }

  return {
    followup: (text: string, options?: { images?: readonly ImageBlock[] }) => {
      if (typeof text !== "string") return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-turn", userBlocks(text, options)));
      wake();
    },
    steer: (text: string, options?: { images?: readonly ImageBlock[] }) => {
      if (typeof text !== "string") return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", userBlocks(text, options)));
      wake();
    },
    notify: (source: string, kind: AgentMessageKind, text: string) => {
      if (typeof text !== "string" || typeof source !== "string" || source === "" || !AGENT_MESSAGE_KINDS.has(kind)) return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", [{ type: "text", text }], { source, kind }));
      wake();
    },
    cancel: (cause: string, options?: { keepInbox?: boolean }) => {
      const safeCause = cause === "" ? "cancelled" : cause;
      cancelled = safeCause;
      if (options?.keepInbox !== true) {
        try {
          appendEvent(session, "agent/inbox/spliced", { op: "clear", reason: safeCause });
        } catch {
        }
      }
      phase?.abort.abort();
    },
    whenIdle: () => {
      if (phase === undefined && cancelled !== undefined) return Promise.resolve();
      if (phase === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idle.push(resolve);
      });
    },
    status: () => (phase !== undefined ? "running" : "idle"),
  };
}

export type { InboxEntry, SessionId };
