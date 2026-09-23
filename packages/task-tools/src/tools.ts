// 工具面 + 三态路由（docs/TASKS.md §1.1/§1.2 + docs/TASK-PUSH-DESIGN.md §2.1）：task_stop 单工具（读面归日志文件与
// [task-notification] 推送）。入口前置
// 校验（空/换行/无调用方/main）→ 逐源 probe（denied 终结透传、miss 续走、单源异常按
// miss 计隔离）→ 源动词 → 迟到 not-found 回落统一词表。

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@x-harness/tools";
import type { SessionId } from "@x-harness/session";
import type { TaskHub, TaskOutcome, TaskProbe, TaskSource } from "./tokens.ts";
import { TASK_STOP_DESCRIPTION } from "./descriptions.ts";

const CALLER_MISSING = "invalid-args:task tools are only available inside an agent session";

/** 全 miss / 迟到 miss 的统一词表：按双源齐备写——纯源装配下他源提示冗余但无害（静态文案不分叉） */
export function notFoundText(taskId: string): string {
  return `not-found:${taskId}; no such task in any source (agent tasks: use list_agents; bash ids come from bash run_in_background; bash tasks are session-scoped)`;
}

const stopSchema = Type.Object({
  task_id: Type.String({ description: "The ID of the background task to stop" }),
});

/** 入口前置校验（不进路由）：denied 同款终结 */
function precheck(taskId: string, caller: SessionId | undefined): string | undefined {
  if (taskId === "") return "invalid-args:task_id must be a non-empty string";
  if (taskId.includes("\n") || taskId.includes("\r")) return "invalid-args:task_id must not contain newlines";
  if (caller === undefined) return CALLER_MISSING;
  if (taskId === "main") return "invalid-args:task_id 'main' is not a task";
  return undefined;
}

/** 路由核：单源 probe/stop 抛错按 miss 计 + onWarn 留痕（单源 bug 不打穿另一源） */
async function route(input: {
  readonly hub: TaskHub;
  readonly onWarn: (message: string) => void;
  readonly taskId: string;
  readonly caller: SessionId;
  readonly run: (source: TaskSource) => Promise<TaskOutcome>;
}): Promise<TaskOutcome> {
  for (const source of input.hub.sources()) {
    let probe: TaskProbe;
    try {
      probe = source.probe(input.taskId, input.caller);
    } catch (error) {
      input.onWarn(`task-tools: source '${source.kind}' probe threw for '${input.taskId}': ${String(error)}`);
      continue;
    }
    if (probe.kind === "miss") continue;
    if (probe.kind === "denied") return { ok: false, reason: probe.reason }; // denied 终结：后源不得遮蔽
    try {
      const out = await input.run(source);
      // 迟到 miss（probe hit 后行消失——档化/逐出竞态）：续试余源，兜底统一词表
      if (!out.ok && out.reason.startsWith("not-found:")) continue;
      return out;
    } catch (error) {
      input.onWarn(`task-tools: source '${source.kind}' threw for '${input.taskId}': ${String(error)}`);
      continue;
    }
  }
  return { ok: false, reason: notFoundText(input.taskId) };
}

function cast(out: TaskOutcome): { content: string; isError?: true } {
  return out.ok ? { content: out.text } : { content: out.reason, isError: true };
}

export function createTaskTools(hub: TaskHub, onWarn: (message: string) => void = () => {}): ToolDefinition[] {
  return [
    {
      name: "task_stop",
      description: TASK_STOP_DESCRIPTION,
      inputSchema: stopSchema,
      execute: async (args: Static<typeof stopSchema>, ctx) => {
        const bad = precheck(args.task_id, ctx.session);
        if (bad !== undefined) return { content: bad, isError: true };
        return cast(await route({ hub, onWarn, taskId: args.task_id, caller: ctx.session as SessionId, run: (source) => source.stop(args.task_id, ctx.session) }));
      },
    },
  ];
}
