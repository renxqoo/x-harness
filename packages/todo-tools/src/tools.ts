// 工具面 + 铸文（docs/TODO.md §1.1/§1.5）：语义校验全在 store（单一真相），本层只铸文。
// 四工具全 parallel：store 操作全同步、无 await 竞态窗口（并发组用例钉死该前提）。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@x-harness/tools";
import type { TodoList, TodoTask } from "./tokens.ts";
import {
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "./descriptions.ts";

const createSchema = Type.Object({
  subject: Type.Optional(Type.String({ description: 'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")' })),
  description: Type.Optional(Type.String({ description: "What needs to be done" })),
  activeForm: Type.Optional(Type.String({ description: 'Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug"). If omitted, shows the subject instead' })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata to attach to the task" })),
});

const getSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the task to retrieve" }),
});

const listSchema = Type.Object({});

const updateSchema = Type.Object({
  taskId: Type.String({ description: "The ID of the task to update" }),
  subject: Type.Optional(Type.String({ description: 'New title for the task (imperative form, e.g., "Run tests")' })),
  description: Type.Optional(Type.String({ description: "New description for the task" })),
  activeForm: Type.Optional(Type.String({ description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")' })),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")], { description: "New status for the task" })),
  owner: Type.Optional(Type.String({ description: "New owner for the task (agent name)" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Merge metadata keys into the task (set a key to null to delete it)" })),
  addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
});

/** BigInt 等合法入库值序列化会 throw——降级占位不崩溃（垃圾输入降级口径） */
function jsonOf(value: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

/** 任务卡片（get/update 回执）：字段缺席省行 */
export function cardText(task: TodoTask): string {
  const lines = [`Task ${task.id}: ${task.subject}`, `Status: ${task.status}`];
  if (task.owner !== undefined) lines.push(`Owner: ${task.owner}`);
  if (task.description !== undefined) lines.push(`Description: ${task.description}`);
  if (task.activeForm !== undefined) lines.push(`Active form: ${task.activeForm}`);
  if (task.metadata !== undefined) lines.push(`Metadata: ${jsonOf(task.metadata)}`);
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.join(", ")}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(", ")}`);
  return lines.join("\n");
}

/** 全清单（数值 id 升序由 store 保证）：一行一任务 + 三段独立注记 */
export function listText(tasks: readonly TodoTask[]): string {
  if (tasks.length === 0) return "No tasks";
  return tasks
    .map((task) => {
      const notes: string[] = [];
      if (task.owner !== undefined) notes.push(`owner: ${task.owner}`);
      if (task.blocks.length > 0) notes.push(`blocks: ${task.blocks.join(", ")}`);
      if (task.blockedBy.length > 0) notes.push(`blocked by: ${task.blockedBy.join(", ")}`);
      const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
      return `${task.id}. [${task.status}] ${task.subject}${note}`;
    })
    .join("\n");
}

/** 错误铸文：reason 枚举即词表前缀（not-found:<id>; no such task / invalid-args:<详情>） */
function cast(result: { readonly ok: false; readonly reason: "not-found" | "invalid-args"; readonly message?: string }): { content: string; isError?: true } {
  return { content: `${result.reason}:${result.message}`, isError: true };
}

export function createTodoTools(store: TodoList): ToolDefinition[] {
  const parallel = (): boolean => true;
  return [
    {
      name: "task_create",
      description: TASK_CREATE_DESCRIPTION,
      inputSchema: createSchema,
      execute: async (args: Static<typeof createSchema>) => {
        const result = store.create({ subject: args.subject ?? "", description: args.description, activeForm: args.activeForm, metadata: args.metadata });
        if (!result.ok) return cast(result);
        return { content: `Created task ${result.task.id}: ${result.task.subject} (status: ${result.task.status})` };
      },
      isConcurrencySafe: parallel,
    },
    {
      name: "task_get",
      description: TASK_GET_DESCRIPTION,
      inputSchema: getSchema,
      execute: async (args: Static<typeof getSchema>) => {
        const result = store.get(args.taskId);
        return result.ok ? { content: cardText(result.task) } : cast(result);
      },
      isConcurrencySafe: parallel,
    },
    {
      name: "task_list",
      description: TASK_LIST_DESCRIPTION,
      inputSchema: listSchema,
      execute: async () => ({ content: listText(store.list()) }),
      isConcurrencySafe: parallel,
    },
    {
      name: "task_update",
      description: TASK_UPDATE_DESCRIPTION,
      inputSchema: updateSchema,
      execute: async (args: Static<typeof updateSchema>) => {
        const result = store.update(args.taskId, {
          subject: args.subject,
          description: args.description,
          activeForm: args.activeForm,
          status: args.status,
          owner: args.owner,
          metadata: args.metadata,
          addBlocks: args.addBlocks,
          addBlockedBy: args.addBlockedBy,
        });
        if (!result.ok) return cast(result);
        if ("deleted" in result) return { content: `Deleted task ${args.taskId}` };
        return { content: cardText(result.task) };
      },
      isConcurrencySafe: parallel,
    },
  ];
}
