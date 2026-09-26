// @x-harness/workflow-core：件 16 纯引擎——零 IO、零 workspace 依赖（只依赖语言内置）。
// fold/verdict/readiness 全部纯函数；穷举单测即状态机规格。

export type {
  BudgetState,
  RunOutcome,
  RunSnapshot,
  RunStatus,
  TaskCause,
  TaskOutcome,
  TaskSpec,
  TaskState,
  TaskStatus,
  TierKind,
  Verdict,
  VerifyOutcome,
  WorkflowEvent,
} from "./types.ts";
export { DEFAULT_BUDGET } from "./types.ts";
export { fold, runReadyToSettle, step, UnknownEventError } from "./fold.ts";
export { adjudicate, adjudicateChain, extractPayload, stripCodeFence, validateSubset } from "./verdict.ts";
export type { Evidence, Violation } from "./verdict.ts";
export type { ReadinessInput, ReadinessResult } from "./readiness.ts";
export { dependencyVerdict, readiness } from "./readiness.ts";
