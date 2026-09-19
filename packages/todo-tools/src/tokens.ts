// todo 清单件契约（docs/TODO.md §13 修订B）：TodoList 服务 + 任务快照类型。
// 清单每会话一份（键控桶）；id 会话内十进制递增；status 无 deleted 态——deleted 即物理移除。
// 快照事件类型复用 session 词条类型（单一真相——docs/TODO.md §13.2）。

import { defineService } from "@x-harness/core";
import type { SessionEvent, SessionId, TodoSnapshotEventData } from "@x-harness/session";

export type { TodoSnapshotEventData, TodoSnapshotTaskData } from "@x-harness/session";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** status 的工具入参形态：deleted 只在更新入参出现（永久移除，不入存储） */
export type TodoStatusInput = TodoStatus | "deleted";

export interface TodoTask {
  readonly id: string;
  readonly subject: string;
  readonly status: TodoStatus;
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 它阻塞谁（数值 id 升序） */
  readonly blocks: readonly string[];
  /** 它被谁阻塞（数值 id 升序） */
  readonly blockedBy: readonly string[];
}

export interface TodoCreateInput {
  readonly subject: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TodoUpdatePatch {
  readonly subject?: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly status?: TodoStatusInput;
  readonly owner?: string;
  readonly metadata?: Record<string, unknown>;
  readonly addBlocks?: readonly string[];
  readonly addBlockedBy?: readonly string[];
}

export type TodoTaskResult = { readonly ok: true; readonly task: TodoTask } | TodoReject;

export type TodoUpdateResult = { readonly ok: true; readonly task: TodoTask } | { readonly ok: true; readonly deleted: true } | TodoReject;

export interface TodoReject {
  readonly ok: false;
  readonly reason: "not-found" | "invalid-args";
  readonly message: string;
}

export interface TodoList {
  /** 服务面 = 内存真相（恒不 append——append 单点住工具面 execute，docs/TODO.md §13.1） */
  create(session: SessionId | undefined, input: TodoCreateInput): TodoTaskResult;
  get(session: SessionId | undefined, taskId: string): TodoTaskResult;
  /** 数值 id 升序快照（本会话桶） */
  list(session: SessionId | undefined): readonly TodoTask[];
  update(session: SessionId | undefined, taskId: string, patch: TodoUpdatePatch): TodoUpdateResult;
  /** 桶闭包状态导出（append 铸事件用） */
  snapshotOf(session: SessionId | undefined): TodoSnapshotEventData;
  /** 惰性恢复：折尾取最后一条 todo/snapshot 深拷贝灌桶；桶在场即跳过（不覆盖内存变更） */
  restore(session: SessionId | undefined, events: readonly SessionEvent[]): void;
  /** sessionDisposed 逐出（同 id 重建 = 新桶） */
  evict(session: SessionId): void;
}

export const todoList = defineService<TodoList>("todo-list");
