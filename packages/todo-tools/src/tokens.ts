// todo 清单件契约（docs/TODO.md §1.4）：TodoList 服务 + 任务快照类型。
// id 是十进制递增字符串；status 无 deleted 态——deleted 即物理移除。

import { defineService } from "@x-harness/core";

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

export type TodoCreateResult = { readonly ok: true; readonly task: TodoTask } | TodoReject;

export type TodoUpdateResult = { readonly ok: true; readonly task: TodoTask } | { readonly ok: true; readonly deleted: true } | TodoReject;

export interface TodoReject {
  readonly ok: false;
  readonly reason: "not-found" | "invalid-args";
  readonly message?: string;
}

export interface TodoList {
  create(input: TodoCreateInput): TodoCreateResult;
  get(taskId: string): TodoCreateResult;
  /** 数值 id 升序快照 */
  list(): readonly TodoTask[];
  update(taskId: string, patch: TodoUpdatePatch): TodoUpdateResult;
}

export const todoList = defineService<TodoList>("todo-list");
