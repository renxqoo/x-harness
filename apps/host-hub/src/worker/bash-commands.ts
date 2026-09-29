import { hubError } from "../shared/errors.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import { respond, requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { Handler, WorkerRuntime } from "./worker-commands.ts";

function bashOutcomeError(reason: string): HubErrorShape {
  if (reason === "permission denied" || reason === "aborted before execution started") return hubError("bash_denied", reason);
  if (reason === "too many concurrent direct bash executions (limit reached)") return hubError("thread_limit", reason);
  if (reason === "concurrent direct bash requires a command id" || reason === "invalid command: required" || reason.startsWith("invalid timeoutMs:")) {
    return hubError("invalid_input", reason);
  }
  if (reason === "bash command id is already in use") return hubError("state_conflict", reason);
  return hubError("internal", reason);
}

export function registerBashCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("bash", async (input) => {
     if (requireThread(rt, { ...input, command: "bash" }) === undefined) return;
     const outcome = await rt.bash.exec({
       command: typeof input.command === "string" ? input.command : "",
       ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
       ...(input.excludeFromContext === true ? { excludeFromContext: true } : {}),
       ...(typeof input.id === "string" && input.id !== "" ? { id: input.id } : {}),
     });
     if (!outcome.ok) {
       respond(rt, { id: input.id, command: "bash", error: bashOutcomeError(outcome.reason) });
       return;
     }
     respond(rt, {
       id: input.id,
       command: "bash",
       data: { output: outcome.output, exitCode: outcome.exitCode, cancelled: outcome.cancelled, truncated: outcome.truncated, ...(outcome.fullOutputPath !== undefined ? { fullOutputPath: outcome.fullOutputPath } : {}) },
     });
   });

   handlers.set("abort_bash", wrapSyncHandler((input) => {
     if (requireThread(rt, { ...input, command: "abort_bash" }) === undefined) return;
     rt.bash.abortAdmissions();
     rt.bash.abortRunning(typeof input.id === "string" && input.id !== "" ? input.id : undefined);
     respond(rt, { id: input.id, command: "abort_bash" });
   }));


}
