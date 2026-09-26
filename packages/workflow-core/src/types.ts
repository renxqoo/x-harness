// 件 16 纯引擎词表（docs/AGENT-WORKFLOW.md §7/§10）：事件与状态的闭合词表——
// fold 判别身份的唯一依据；未知事件类型 fail-closed（词表判别，无版本字段）。

/** 事件类型闭合词表（journal 落盘形态：{type, ...payload}） */
export type WorkflowEvent =
  | { readonly type: "run/created"; readonly runId: string; readonly parentSession: string; readonly cwd: string }
  | { readonly type: "run/settled"; readonly outcome: RunOutcome; readonly detail: string }
  | { readonly type: "run/rebound"; readonly from: string; readonly to: string }
  | { readonly type: "task/submitted"; readonly taskId: string; readonly spec: TaskSpec }
  | { readonly type: "task/dispatched"; readonly taskId: string; readonly agentId: string; readonly sessionId: string }
  | { readonly type: "task/repair-issued"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number; readonly violations?: readonly string[]; readonly output?: string }
  | { readonly type: "verify/started"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number }
  | { readonly type: "verify/result"; readonly taskId: string; readonly tier: TierKind; readonly attempt: number; readonly outcome: VerifyOutcome; readonly exitCode?: number }
  | { readonly type: "task/reopened"; readonly taskId: string; readonly attempt: number }
  | { readonly type: "task/settled"; readonly taskId: string; readonly outcome: TaskOutcome; readonly verdict?: string; readonly detail?: string; readonly evidence?: string; readonly cause?: TaskCause }
  | { readonly type: "notify/delivered"; readonly taskId: string; readonly to: string };

export type RunOutcome = "completed" | "failed" | "cancelled";
export type TaskOutcome = "completed" | "failed" | "cancelled";
export type TierKind = "schema" | "command" | "critic";
export type VerifyOutcome = "passed" | "failed" | "unknown";

/** task/settled.cause 闭合词表（§7：级联与终局的原因可判别） */
export type TaskCause =
  | "dispatch-failed"
  | "dependency-failed"
  | "circuit-break"
  | "child-failed"
  | "settle-failed"
  | "type-def-missing"
  | "verify-unknown"
  | "task-stop";

/** 提交参数（spec 原样落 journal——裁决依据；演进取舍见方案 §4） */
export interface TaskSpec {
  readonly description: string;
  readonly prompt: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly isolation?: string;
  readonly resultSchema?: unknown;
  readonly acceptance?: { readonly command: string; readonly cwd?: string };
  readonly critic?: { readonly type: string; readonly focus?: string };
  readonly maxAttempts?: number;
  /** 依赖的 taskId 集（期 2 DAG——就绪判定在 readiness.dependencyVerdict） */
  readonly dependsOn?: readonly string[];
}

// ————————————————————————— 快照（fold 的产出，§10 状态机规格） —————————————————————————

export type TaskStatus =
  | "submitted"
  | "dispatched"
  | "repairing"
  | "verifying"
  | "settled";

export interface TaskState {
  readonly taskId: string;
  readonly spec: TaskSpec;
  readonly status: TaskStatus;
  /** dispatched 起在场（journal↔子会话 WAL 双锚） */
  readonly agentId?: string;
  readonly sessionId?: string;
  /** 回炉计数（repair-issued/reopened 各自累计，§8 预算扣减依据） */
  readonly repairs: number;
  readonly reopens: number;
  readonly verifyAttempts: number;
  readonly outcome?: TaskOutcome;
  readonly cause?: TaskCause;
  /** 终态裁决标记（如 schema:accept / schema:budget-exhausted）与详情 */
  readonly verdict?: string;
  readonly detail?: string;
  /** 已验收交付物尾料（B-9：成功路径落账 report.summary 截断——通知回传核心） */
  readonly evidence?: string;
  /** 终态后收编的迟到事件（§7 后事件规则——留档不参与状态） */
  readonly trailing: readonly WorkflowEvent[];
}

export type RunStatus = "created" | "settled";

export interface RunSnapshot {
  readonly runId: string;
  readonly parentSession: string;
  readonly cwd: string;
  readonly status: RunStatus;
  readonly outcome?: RunOutcome;
  readonly settledDetail?: string;
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly notified: ReadonlySet<string>;
  /** 连续 failed 计数（熔断判定——依赖传播/取消不计入） */
  readonly consecutiveFailures: number;
}

// ————————————————————————— 裁决（§8.1 两层中的纯函数半） —————————————————————————

export type Verdict =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly violations: readonly string[] }
  | { readonly kind: "fail"; readonly reason: string };

/** 预算（§8.2 装配参数——引擎只消费数字，不持有配置） */
export interface BudgetState {
  readonly repairs: number;
  readonly reopens: number;
  readonly verifyAttempts: number;
}

export const DEFAULT_BUDGET: BudgetState = { repairs: 3, reopens: 3, verifyAttempts: 3 };
