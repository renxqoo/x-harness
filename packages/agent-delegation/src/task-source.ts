// agent 任务源（docs/TASKS.md §4-2）：verbs 的 output/stop 包成 TaskSource 注册进
// task-tools 的 hub。probe = nameaddr 解析 + owner 预检——denied（not-owner）终结透传，
// miss 续走 bash 源；无效调用方判定在工具入口前置完成，此处为全量防御。

import type { SessionId } from "@x-harness/session";
import type { TaskProbe, TaskSource } from "@x-harness/task-tools";
import type { VerbDeps } from "./verbs.ts";
import { output, stop } from "./verbs.ts";
import { resolveAddress } from "./nameaddr.ts";

const ONLY_IN_SESSION = "invalid-args:agent tools are only available inside an agent session";
const MAIN_IS_NOT_A_TASK = "invalid-args:task_id 'main' is not a task";

export function agentTaskSource(deps: VerbDeps): TaskSource {
  return {
    kind: "agent",
    probe: (taskId: string, caller: SessionId | undefined): TaskProbe => {
      if (taskId === "") return { kind: "denied", reason: "invalid-args:task_id must be a non-empty string" };
      if (caller === undefined) return { kind: "denied", reason: ONLY_IN_SESSION };
      const resolved = resolveAddress(deps.lineage, caller, taskId);
      if (resolved.kind === "miss") return { kind: "miss" };
      if (resolved.kind === "main") return { kind: "denied", reason: MAIN_IS_NOT_A_TASK };
      if (caller !== resolved.row.parent) {
        return { kind: "denied", reason: `not-owner:${resolved.row.agentId}; you can only read/stop sub-agents you spawned` };
      }
      return { kind: "hit" };
    },
    output: (taskId, caller, opts) =>
      output(deps, caller, {
        task_id: taskId,
        ...(opts.block !== undefined ? { block: opts.block } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      }),
    stop: (taskId, caller) => stop(deps, caller, taskId),
  };
}
