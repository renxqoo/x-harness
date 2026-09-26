// 件 16 插件类型（docs/AGENT-WORKFLOW.md §2/§9）。

import type { AgentLoopService } from "@x-harness/agent-loop";
import type { SessionStore, SessionId } from "@x-harness/session";
import type { DelegationView } from "@x-harness/agent-delegation";
import type { BudgetState, RunSnapshot, TaskSpec, WorkflowEvent } from "@x-harness/workflow-core";
import type { JournalWriter, RunHeader } from "./journal.ts";

export interface WorkflowOptions {
  /** journal 根（必收——插件零目录知识，宿主边沿用 resolveWorkflowRoot 统一解析） */
  readonly root: string;
  /** 本进程主会话 id（§5.1 过滤条件②判值——CLI 先铸 id / hub thread 会话，mailbox mainSession 先例同构） */
  readonly mainSession: SessionId;
  /** 预算（缺省 DEFAULT_BUDGET） */
  readonly budget?: BudgetState;
  /** 非致命告警出口 */
  readonly onWarn?: (message: string) => void;
}

/** 驱动面 deps（plugin apply 注入） */
export interface WorkflowDeps extends WorkflowOptions {
  readonly ctx: import("@x-harness/core").Context;
  /** 冷缓存预热面（期 2-D2——runtime 提供；可选：B7 冻结路径也经 deps 预热） */
  warmColdIndex?: (tasks: Readonly<Record<string, unknown>>, parent: string) => void; // 可变（构造序回填）
  readonly loop: AgentLoopService;
  readonly store: SessionStore;
  readonly view: DelegationView | undefined;
  /** 会话档案面（恢复读子会话 WAL 必需——softInject session-persistence-jsonl 的 tryUse 结果） */
  readonly archive?: import("@x-harness/session").SessionArchive;
}

/** 活跃 run 的驱动句柄 */
export interface ActiveRun {
  /** rebind（期 2-A）迁移归属时可变——journal/header/内存三面同值 */
  header: RunHeader;
  readonly writer: JournalWriter;
  snapshot: RunSnapshot;
}

export interface WorkflowRuntime {
  /** workflow_submit 入口（工具面调用）：直通或受管开跑 */
  submit(caller: SessionId | undefined, input: SubmitInput): Promise<SubmitOutcome>;
  /** 受管子代理周期终结（SettlementSink.onCycleEnd）——验收回炉闭环 */
  onCycleEnd(task: ManagedTaskRef, report: ManagedReport): Promise<void>;
  /** §5.3 边沿：主会话建立/复活 → 补投悬置通知 */
  onSessionAlive(session: SessionId): Promise<void>;
  /** 插件 dispose（§2 序列：受管不 cancel；journal 尽力 flush） */
  dispose(): Promise<void>;
  /** 恢复协议接线（§5.2）：恢复 run 接进驱动面；返回该 run 的 onCycleEnd（验收闭环复用） */
  attach(run: ActiveRun): (agentId: string, report: ManagedReport) => Promise<void>;
  /** task_stop 让位协议（§9）：probe 三态（TaskSource 协议同款） */
  probeTask(taskId: string, caller: SessionId | undefined): { kind: "hit" } | { kind: "denied"; reason: string } | { kind: "miss" };
  /** task_stop：run settle{cancelled} + 受管行归还；not-found: 前缀 = 迟到 miss 纪律 */
  stopTask(taskId: string, caller: SessionId | undefined): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /** §5.2 行 2：submitted 任务重派发（spec 在 journal；死父悬置返回 false） */
  redispatch(run: ActiveRun, caller: SessionId): Promise<boolean>;
  /** 恢复终局摘除（B8）：run 出驱动面（防缓泄与 probe 误 hit） */
  detach(runId: string): void;
  /** 会话重绑（期 2-A）：/new、/resume 后迁移 run 归属 + 悬置通知补投（与 rebindMailbox 同构） */
  rebind(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 冷缓存预热（期 2-D2）：扫描发现的未认领任务登记（task_stop 的 probe 命中面） */
  warmColdIndex(tasks: Readonly<Record<string, unknown>>, parent: string): void;
}

/** 提交参数（工具 schema 的 TS 形态） */
export interface SubmitInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly isolation?: string;
  readonly result_schema?: unknown;
  readonly acceptance?: { readonly command: string; readonly cwd?: string };
  readonly critic?: { readonly type: string; readonly focus?: string };
  readonly max_attempts?: number;
  readonly depends_on?: readonly string[];
}

export type SubmitOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** 受管任务引用（settlement 闭包携带——journal 对齐键） */
export interface ManagedTaskRef {
  readonly runId: string;
  readonly taskId: string;
}

/** 受管周期报告（SettlementSink 面的本地形态——delegation ManagedCycleReport 收窄） */
export interface ManagedReport {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly outcome: "completed" | "stopped" | "failed";
  readonly detail: string;
  readonly summary?: string;
}

export type { TaskSpec, WorkflowEvent };
