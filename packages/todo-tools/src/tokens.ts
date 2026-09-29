import { defineService } from "@x-harness/core";
import type { SessionEvent, SessionId, TodoSnapshotEventData } from "@x-harness/session";

export type { TodoSnapshotEventData, TodoSnapshotTaskData } from "@x-harness/session";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoStatusInput = TodoStatus | "deleted";

export interface TodoTask {
  readonly id: string;
  readonly subject: string;
  readonly status: TodoStatus;
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly blocks: readonly string[];
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
  create(session: SessionId | undefined, input: TodoCreateInput): TodoTaskResult;
  get(session: SessionId | undefined, taskId: string): TodoTaskResult;
  list(session: SessionId | undefined): readonly TodoTask[];
  update(session: SessionId | undefined, taskId: string, patch: TodoUpdatePatch): TodoUpdateResult;
  snapshotOf(session: SessionId | undefined): TodoSnapshotEventData;
  restore(session: SessionId | undefined, eventsOf: () => readonly SessionEvent[]): void;
  evict(session: SessionId): void;
}

export const todoList = defineService<TodoList>("todo-list");
