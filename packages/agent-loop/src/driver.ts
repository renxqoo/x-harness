// 驱动生命周期（docs/AGENT-LOOP-DRIVER.md §1.4/§1.7）：单飞行 turn；kick/turn 步循环、
// 唤醒与取消边界（sticky 取消以 kick 边界为界——cancel 后再 followup 必须可用）、
// 逃逸 throw 单次收轮；步相位函数在 step.ts。

import type { AgentMessageKind, ContentBlock, ImageBlock, InboxEntry, Session, SessionId } from "@x-harness/session";
import { agentMessageData, AGENT_MESSAGE_KINDS } from "@x-harness/session";
import { errorText } from "@x-harness/core";
import { foldInbox, insertData } from "./inbox.ts";
import { concludeWindow } from "./continuation.ts";
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
  runAttempt,
  scheduleTools,
  settleConclude,
} from "./step.ts";
import type { AssistantSettled, DriverDeps, ResolvedOptions, StepEntry, TurnOutcome, TurnScope } from "./step.ts";

export type { DriverDeps, ResolvedOptions };

/** 步入口早退：空领取 → completed；preStep 否决 → blocked（携否决原因）；enter → undefined 继续 */
function entryOutcome(entry: StepEntry): TurnOutcome | undefined {
  if (entry.kind === "empty") return { kind: "completed" };
  if (entry.kind === "blocked") return { kind: "blocked", ...(entry.reason !== undefined ? { reason: entry.reason } : {}) };
  return undefined;
}

/** 步内批次材料化（docs/AGENT-MESSAGE.md §4 场景 C）：连续未标条目合并一条 user/message
 *  （现状形态零漂移）；带 origin 条目逐条材料化为 agent/message（UI 类型隐藏、摘要按 kind
 *  分流——delegation 报告等内部消息经 notify 入队）。事件序 = 条目序（保序）。 */
function appendUserBatch(scope: TurnScope, step: number, entry: StepEntry): void {
  const { deps, turn } = scope;
  if (entry.kind !== "enter" || entry.entries.length === 0) return;
  const session = deps.session;
  let plain: ContentBlock[] = []; // 未标条目累积（user 域——image 块合法，原样搬运）
  const flushPlain = (): void => {
    if (plain.length === 0) return; // 例外：全空 content 条目（唯 preStep 改写可达）不再落空 user/message——语义改进，非漂移
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

/** 链式条件：未取消、终态 completed、收件箱有存货（next-turn ∨ next-step）——
 *  异常终态（error/max-tokens/aborted/blocked）一律不链：排队消息原地保留（下次 kick
 *  的 step0 消费），立即 idle 让失败通知出。next-step 析取支是纯防御子句：现驱动流中
 *  completed 收轮前必经 stopping 窗口重读（step.ts stoppingResumes 读1/读2）与下一步
 *  的 claimStepBatch，next-step 存货在那两处已被消费——此分支防未来重构挪动收尾序列
 *  时开真实搁浅口；改道/steer 条目的实际保障 = stopping 窗口 + 下次 kick 的 step0
 *  claimTurnBatch（含 next-step 全部）。 */
export function chainsNextTurn(cancelled: string | undefined, turnEnds: TurnOutcome | undefined, session: Session): boolean {
  if (cancelled !== undefined) return false;
  if (turnEnds !== undefined && turnEnds.kind !== "completed") return false;
  const inbox = foldInbox(session.events());
  return inbox.nextTurn.length > 0 || inbox.nextStep.length > 0;
}

/** 逃逸路径的括号收尾：step/end 闭不上为止（已封存），错误路径括号形状一致 */
function closeOpenStep(session: Session, turnNumber: number, openStep: number): void {
  if (openStep < 0) return;
  try {
    appendEvent(session, "step/end", { turn: turnNumber, step: openStep });
  } catch {
    /* 已封存：闭不上为止（turn/end 路径同策） */
  }
}

/** turn 级可变状态穿引对象（turn 复杂度治理——concludeStep 与 turn 共享） */
interface TurnState {
  turnEnds: TurnOutcome | undefined;
  pendingConclude: boolean;
  openStep: number;
}

/** 步终态短路闭括号（dialFailure/fatal/interrupted/tools-aborted 同形：merge → step/end；
 *  break 由调用方） */
function closeStepOutcome(spec: { readonly session: Session; readonly state: TurnState; readonly turn: number; readonly step: number }, outcome: TurnOutcome): void {
  spec.state.turnEnds = mergeOutcome(spec.state.turnEnds, outcome);
  appendEvent(spec.session, "step/end", { turn: spec.turn, step: spec.step });
  spec.state.openStep = -1;
}

/** 步收尾走向：resume = 窗口续跑（调用方置续写步标志 continue）；break = turnEnds 已定；
 *  loop = stopping 续航未触发，进下一迭代 */
type StepFlow = { readonly kind: "resume" } | { readonly kind: "break" } | { readonly kind: "loop" };

interface ConcludeStepSpec {
  readonly scope: TurnScope;
  readonly turn: number;
  readonly step: number;
  readonly state: TurnState;
  readonly assistant: AssistantSettled;
  readonly cancelled: string | undefined;
}

/** 步入口（turn 复杂度治理）：正常步领取收件箱、续写步不领取（暂停吸收排队输入——
 *  docs/OUTPUT-TOKEN-CONTINUATION.md）；早退终态（empty/blocked）合并入 state，返回
 *  undefined 表示调用方应 break */
async function enterStep(spec: { readonly scope: TurnScope; readonly step: number; readonly continuationStep: boolean; readonly state: TurnState }): Promise<StepEntry | undefined> {
  const entry = spec.continuationStep ? await concludeStepEntry(spec.scope, spec.step) : await beginStep(spec.scope, spec.step, spec.step === 0);
  const early = entryOutcome(entry);
  if (early !== undefined) {
    spec.state.turnEnds = mergeOutcome(spec.state.turnEnds, early);
    return undefined;
  }
  return entry;
}

/** 步收尾（turn 复杂度治理——工具调度 → 收束窗口 → settleConclude → stopping 续航收口于此）：
 *  收束窗口 = 无工具 settle 即将结束 turn 的通用时点（内核不识「截断」，判定归插件；带
 *  tool_use 的 settle 执行工具进下一步，收束点不可达——「有工具不续跑」是结构保证）。 */
async function concludeStep(spec: ConcludeStepSpec): Promise<StepFlow> {
  const { scope, turn, step, state, assistant, cancelled } = spec;
  const { deps, controller } = scope;
  const session = deps.session;
  const tools = await scheduleTools(scope, step, assistant);
  if (tools.kind === "aborted") {
    closeStepOutcome({ session, state, turn, step }, abortedOutcome(cancelled));
    return { kind: "break" };
  }
  if (tools.kind === "none") {
    const flow = await concludeWindow(scope, step, assistant);
    if (flow.kind === "resume") {
      // 指令已落卷（agent/message{directive}）；出口不变量：turnEnds 保持 undefined
      // （粘性残留会把续写成功的轮误收 max-tokens 终态——chainsNextTurn 断链/delegation 误报）
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
    if (flow.sticky) state.turnEnds = mergeOutcome(state.turnEnds, { kind: "max-tokens" }); // 无决策路径：现行粘性
  } else if (assistant.stopReason === "max-tokens") {
    state.turnEnds = mergeOutcome(state.turnEnds, { kind: "max-tokens" }); // 带工具路径：现行粘性（行为等价重排）
  }
  const settled = settleConclude({ current: state.turnEnds, flow: tools, assistant, pendingConclude: state.pendingConclude, session });
  state.turnEnds = settled.turnEnds;
  state.pendingConclude = settled.pendingConclude;
  appendEvent(session, "step/end", { turn, step });
  state.openStep = -1;
  state.turnEnds = await maybeResume(scope, state.turnEnds); // stopping 续航（仅 completed）
  return state.turnEnds !== undefined ? { kind: "break" } : { kind: "loop" };
}

/** followup/steer 投递块：text 块恒在（空串 text 由 LLM 映射层过滤，WAL 形状稳定——
 *  纯图 prompt 由此支持）+ 结构合法的 image 块（垃圾形状降级丢弃，严格校验在 hub 边缘） */
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
      // 先判 replay 再发 idle：replay 边界不发假 idle——同步监听者（evictIdle 驻留档化/
      // 邮箱状态镜像）不得在「即将继续」的边界上做生命周期决策（假 idle 可致 dispose 压掉
      // replay 并 clear 掉锁存的排队消息）。锁存唤醒 replay 仅在收件箱确有 next-turn 时
      // （链式条件可能已消费——双触发会造空 turn）。
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
    const controller = new AbortController(); // 新 controller 先换引用后落账（F5）
    const turnNumber = nextTurnNumber();
    failedTurnRef.turn = turnNumber;
    const scope: TurnScope = { deps, controller, turn: turnNumber };
    phase = { abort: controller, turn: turnNumber };
    const state: TurnState = { turnEnds: undefined, pendingConclude: false, openStep: -1 }; // openStep：已落 step/start 未落 step/end 的步号（catch 收尾闭括号用）
    try {
      appendEvent(session, "turn/start", { turn: turnNumber });
      let continuationStep = false; // 下一步为续写步（收束窗口 resume 决策置位；步入口消费——turn 局部唯一新内核状态）
      for (let step = 0; ; step++) {
        if (controller.signal.aborted) {
          state.turnEnds = mergeOutcome(state.turnEnds, abortedOutcome(cancelled));
          break;
        }
        // 步入口：正常步领取收件箱；续写步不领取（暂停吸收排队输入——docs/OUTPUT-TOKEN-CONTINUATION.md）
        const entry = await enterStep({ scope, step, continuationStep, state });
        if (entry === undefined) break;
        appendEvent(session, "step/start", { turn: turnNumber, step });
        state.openStep = step;
        anchorSystem(scope, step);
        const isContinuationStep = continuationStep;
        continuationStep = false; // 步入口即消费：后续步默认恢复正常步形态
        if (!isContinuationStep) appendUserBatch(scope, step, entry); // 续写步不落 user 批次（指令已在投影末条）
        const dialed = await dialStep(scope, step);
        if (dialed.kind !== "dial") {
          closeStepOutcome({ session, state, turn: turnNumber, step }, dialFailure(dialed.kind)); // 错误也闭 step：括号形状一致
          break;
        }
        const attempt = await runAttempt({ scope, dial: dialed.dial, schemas: dialed.schemas, step });
        if (attempt.kind === "fatal") {
          closeStepOutcome({ session, state, turn: turnNumber, step }, fatalOutcome(controller, cancelled, attempt.outcome));
          break;
        }
        if (attempt.message.interrupted === true) {
          // 中断的消息：turn 以 aborted 收尾（部分内容已保序落账）
          closeStepOutcome({ session, state, turn: turnNumber, step }, abortedOutcome(cancelled));
          break;
        }
        const flow = await concludeStep({ scope, turn: turnNumber, step, state, assistant: attempt.message, cancelled });
        if (flow.kind === "resume") {
          continuationStep = true;
          continue; // 收束窗口续跑：下一步为续写步
        }
        if (flow.kind === "break") break;
      }
    } catch (error) {
      // 逃逸 throw（中间件违约/append 失败等）：闭开着的 step 括号后以 error 单次收尾
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
      if (typeof text !== "string") return; // 垃圾输入降级：不落账不唤醒
      appendEvent(session, "agent/inbox/spliced", insertData("next-turn", userBlocks(text, options)));
      wake();
    },
    steer: (text: string, options?: { images?: readonly ImageBlock[] }) => {
      if (typeof text !== "string") return;
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", userBlocks(text, options)));
      wake();
    },
    /** 内部消息注入（docs/AGENT-MESSAGE.md §5）：next-step 排队 + 唤醒（steer 同款边界
     *  语义）——领取时材料化为 agent/message{source,kind}，UI 不展示、摘要按 kind 分流 */
    notify: (source: string, kind: AgentMessageKind, text: string) => {
      if (typeof text !== "string" || typeof source !== "string" || source === "" || !AGENT_MESSAGE_KINDS.has(kind)) return; // 垃圾输入降级：不落账不唤醒（steer 守卫同款完备）
      appendEvent(session, "agent/inbox/spliced", insertData("next-step", [{ type: "text", text }], { source, kind }));
      wake();
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
