import type { HubErrorShape } from "../shared/errors.ts";
import type { CommandOutcome } from "./outcome.ts";
import { bashOutcomeError } from "./send.ts";

export interface BashExecFace {
  exec(spec: { command: string; timeoutMs?: number; excludeFromContext?: boolean; id?: string }): Promise<
    | { ok: true; output: string; exitCode: number; cancelled: boolean; truncated: boolean; fullOutputPath?: string }
    | { ok: false; reason: string }
  >;
  abortAdmissions(): void;
  abortRunning(id: string | undefined): void;
}

export interface BashCommandState {
  bash: BashExecFace;
}

export async function bash(state: BashCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const outcome = await state.bash.exec({
    command: typeof input.command === "string" ? input.command : "",
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.excludeFromContext === true ? { excludeFromContext: true } : {}),
    ...(typeof input.id === "string" && input.id !== "" ? { id: input.id } : {}),
  });
  if (!outcome.ok) return { command: "bash", error: bashOutcomeError(outcome.reason) };
  return {
    command: "bash",
    data: { output: outcome.output, exitCode: outcome.exitCode, cancelled: outcome.cancelled, truncated: outcome.truncated, ...(outcome.fullOutputPath !== undefined ? { fullOutputPath: outcome.fullOutputPath } : {}) },
  };
}

export function abortBash(state: BashCommandState, input: Record<string, unknown>): CommandOutcome {
  state.bash.abortAdmissions();
  state.bash.abortRunning(typeof input.id === "string" && input.id !== "" ? input.id : undefined);
  return { command: "abort_bash" };
}

export { bashOutcomeError };
export type { HubErrorShape };
