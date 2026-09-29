import type { SessionId } from "@x-harness/session";
import type { TaskProbe, TaskSource } from "@x-harness/task-tools";
import type { VerbDeps } from "./verbs.ts";
import { stop } from "./verbs.ts";
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
      if (resolved.row.settlement !== undefined) return { kind: "miss" };
      if (caller !== resolved.row.parent) {
        return { kind: "denied", reason: `not-owner:${resolved.row.agentId}; you can only stop/message sub-agents you spawned` };
      }
      return { kind: "hit" };
    },
    stop: (taskId, caller) => stop(deps, caller, { taskId }),
  };
}
