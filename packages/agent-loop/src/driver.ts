// 驱动生命周期（docs/AGENT-LOOP-DRIVER.md §1.4/§1.7）：单飞行 turn；kick/turn 步循环、
// 唤醒与取消边界（sticky 取消以 kick 边界为界——cancel 后再 followup 必须可用）、
// 逃逸 throw 单次收轮；步相位函数在 step.ts。

import type { InboxEntry, Session, SessionId } from "@x-harness/session";
import { errorText } from "@x-harness/core";
import { foldInbox, insertData } from "./inbox.ts";
import {
  anchorSystem,
  appendEvent,
  appendSurfaceEvent,
  beginStep,
  dialFailure,
  dialStep,
  fatalOutcome,
  maybeResume,
  mergeOutcome,
  abortedOutcome,
  runAttempt,
  scheduleTools,
  settleConclude,
} from "./step.ts";
import type { DriverDeps, ResolvedOptions, StepEntry, TurnOutcome, TurnScope } from "./step.ts";

export type { DriverDeps, ResolvedOptions };

/** 步入口早退：空领取 → completed；preStep 否决 → blocked；enter → undefined 继续 */
function entryOutcome(entry: StepEntry): TurnOutcome | undefined {
  if (entry.kind === "empty") return { kind: "completed" };
  if (entry.kind === "blocked") return { kind: "blocked" };
  return undefined;
}

function appendUserBatch(scope: TurnScope, step: number, entry: StepEntry): void {
  const { deps, turn } = scope;
  if (entry.kind !== "enter" || entry.entries.length === 0) return;
  const content = entry.entries.flatMap((item) => [...item.content]);
  appendSurfaceEvent(deps.session, { type: "user/message", data: { turn, step, content }, surfaceOp: "append" });
}

/** 链式条件：未取消、非 blocked、有 next-turn */
function chainsNextTurn(cancelled: string | undefined, turnEnds: TurnOutcome | undefined, session: Session): boolean {
  if (cancelled !== undefined) return false;
  if (turnEnds?.kind === "blocked") return false;
  return foldInbox(session.events()).nextTurn.length > 0;
}

function turnEndData(turn: number, reason: TurnOutcome): Record<string, unknown> {
  if (reason.kind === "aborted") {
    return { turn, reason: { kind: "aborted", ...(reason.cause !== "" ? { cause: reason.cause } : {}) } };
  }
  if (reason.kind === "error") {
    return { turn, reason: { kind: "error", message: reason.message, ...(reason.code !== undefined ? { code: reason.code } : {}) } };
  }
  return { turn, reason: { kind: reason.kind } };
}

export function createDriver(deps: DriverDeps): {
  readonly followup: (text: string) => void;
  readonly steer: (text: string) => void;
  readonly inject: (text: string) => void;
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

  // 唤醒不查 cancelled：sticky 取消以 kick 边界为界（kick 头复位）——cancel 后再 followup 必须可用，
  // 否则一次取消永久砖化；dispose 之后的抑制由 session 封存（append fail-closed）承担
  const wake = (): void => {
    if (phase !== undefined) {
      wakeRequested = true;
      return;
    }
    void kick();
  };

  const notifyIdle = (): void => {
    if (phase !== undefined) return; // 新 kick 已启动（idle 监听器重入 followup）：由其 finally 收尾通知
    for (const resolve of idle) resolve();
    idle = [];
  };

  async function kick(): Promise<void> {
    if (phase !== undefined) return;
    cancelled = undefined;
    deps.emitStatus("running");
    try {
      while (cancelled === undefined && (await turn())) {
        /* 链式 */
      }
    } catch (error) {
      // turn() 自身兜底后的最后背书（不变量破坏）：不落账只上报
      deps.emitError(failedTurnRef.turn, errorText(error));
    } finally {
      phase = undefined;
      deps.emitStatus("idle");
      // 锁存唤醒 replay 仅在收件箱确有 next-turn 时（链式条件可能已消费——双触发会造空 turn）
      if (wakeRequested && cancelled === undefined && foldInbox(session.events()).nextTurn.length > 0) {
        wakeRequested = false;
        void kick();
      } else {
        wakeRequested = false;
        notifyIdle();
      }
    }
  }

  async function turn(): Promise<boolean> {
    if (cancelled !== undefined) return false;
    const controller = new AbortController(); // 新 controller 先换引用后落账（F5）
    const turnNumber = nextTurnNumber();
    failedTurnRef.turn = turnNumber;
    const scope: TurnScope = { deps, controller, turn: turnNumber };
    phase = { abort: controller, turn: turnNumber };
    let turnEnds: TurnOutcome | undefined;
    let pendingConclude = false;
    try {
      appendEvent(session, "turn/start", { turn: turnNumber });
      for (let step = 0; ; step++) {
        if (controller.signal.aborted) {
          turnEnds = mergeOutcome(turnEnds, abortedOutcome(cancelled));
          break;
        }
        const entry = await beginStep(scope, step, step === 0);
        const early = entryOutcome(entry);
        if (early !== undefined) {
          turnEnds = mergeOutcome(turnEnds, early);
          break;
        }
        appendEvent(session, "step/start", { turn: turnNumber, step });
        anchorSystem(scope, step);
        appendUserBatch(scope, step, entry);
        const dialed = await dialStep(scope, step);
        if (dialed.kind !== "dial") {
          turnEnds = mergeOutcome(turnEnds, dialFailure(dialed.kind));
          appendEvent(session, "step/end", { turn: turnNumber, step }); // 错误也闭 step：括号形状一致
          break;
        }
        const attempt = await runAttempt({ scope, dial: dialed.dial, schemas: dialed.schemas, step });
        if (attempt.kind === "fatal") {
          turnEnds = mergeOutcome(turnEnds, fatalOutcome(controller, cancelled, attempt.outcome));
          appendEvent(session, "step/end", { turn: turnNumber, step });
          break;
        }
        const assistant = attempt.message;
        if (assistant.interrupted === true) {
          // 中断的消息：turn 以 aborted 收尾（部分内容已保序落账）
          turnEnds = mergeOutcome(turnEnds, abortedOutcome(cancelled));
          appendEvent(session, "step/end", { turn: turnNumber, step });
          break;
        }
        if (assistant.stopReason === "max-tokens") {
          turnEnds = mergeOutcome(turnEnds, { kind: "max-tokens" });
        }
        const tools = await scheduleTools(scope, step, assistant);
        if (tools.kind === "aborted") {
          turnEnds = mergeOutcome(turnEnds, abortedOutcome(cancelled));
          appendEvent(session, "step/end", { turn: turnNumber, step });
          break;
        }
        const settled = settleConclude({ current: turnEnds, flow: tools, assistant, pendingConclude, session });
        turnEnds = settled.turnEnds;
        pendingConclude = settled.pendingConclude;
        appendEvent(session, "step/end", { turn: turnNumber, step });
        turnEnds = await maybeResume(scope, turnEnds); // stopping 续航（仅 completed）
        if (turnEnds !== undefined) break;
      }
    } catch (error) {
      // 逃逸 throw（中间件违约/append 失败等）：turn 以 error 单次收尾
      turnEnds = mergeOutcome(turnEnds, { kind: "error", message: errorText(error) });
    } finally {
      const reason = turnEnds ?? { kind: "completed" as const };
      try {
        appendEvent(session, "turn/end", turnEndData(turnNumber, reason));
      } catch {
        deps.emitError(turnNumber, "turn/end append failed");
      }
      if (reason.kind === "error") deps.emitError(turnNumber, reason.message);
    }
    return chainsNextTurn(cancelled, turnEnds, session);
  }

  function nextTurnNumber(): number {
    let max = -1;
    for (const event of session.events()) {
      if (event.type === "turn/start" && event.data.turn > max) max = event.data.turn;
    }
    return max + 1;
  }

  return {
    followup: (text: string) => {
      if (typeof text !== "string") return; // 垃圾输入降级：不落账不唤醒
      appendEvent(session, "agent/inbox/spliced", insertData("next-turn", [{ type: "text", text }]));
      wake();
    },
    steer: (text: string) => {
      if (typeof text !== "string") return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", [{ type: "text", text }]));
      wake();
    },
    inject: (text: string) => {
      if (typeof text !== "string") return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", [{ type: "text", text }]));
    },
    cancel: (cause: string, options?: { keepInbox?: boolean }) => {
      const safeCause = cause === "" ? "cancelled" : cause;
      cancelled = safeCause; // per-kick sticky（链式窗口防丢）
      if (options?.keepInbox !== true) {
        try {
          appendEvent(session, "agent/inbox/spliced", { op: "clear", reason: safeCause });
        } catch {
          /* 已封存：clear 落不上也不阻断 abort */
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
