import type { Invocation } from "../../../../core/src/index";
import { normalizeResult } from "../../../../core/src/validation";
import type { ValidateFunction } from "ajv";
import type { ExecutionFacade } from "../../../execution/src/index";
import type { CatalogEntry } from "../contributions/read-contribution";
import type { ToolRequest } from "../contracts/types";
import type { ToolExecutionPlan } from "../planning/types";
import type { Origin } from "../../../../core/src/index";
export interface ToolRunData {
  readonly entry: CatalogEntry;
  readonly request: ToolRequest;
  readonly caller: Origin;
  readonly cancel: (reason: "cancelled" | "timeout") => void;
  readonly plan: ToolExecutionPlan;
  readonly execution?: ExecutionFacade;
}
import type { ToolOutput, ToolsLimits, ToolsResult, ToolInvocation } from "../contracts/types";
import { readJson } from "../domain/read-json";
import { readOutput } from "../domain/read-output";
import { readError } from "../domain/read-error";
import { fail } from "../domain/fail";
import { createProgress } from "./create-progress";
import { extendInvocation } from "./extend-invocation";

export async function runTool(options: {
  ticket: ToolRunData;
  call: Invocation;
  limits: ToolsLimits;
  inputSchema: ValidateFunction;
  outputSchema: ValidateFunction | undefined;
  execute: (input: unknown, call: ToolInvocation) => unknown;
}): Promise<ToolsResult<ToolOutput>> {
  const { ticket, call, limits, inputSchema, outputSchema, execute } = options;
  const parsed = readJson(ticket.request.input, { maxBytes: limits.maxInputBytes });

  if (!parsed.ok) return parsed;

  if (!inputSchema(parsed.value)) return fail("invalid-input");

  const progress = createProgress({
    call,
    callback: ticket.request.onProgress,
    limits,
    cancel: ticket.cancel,
  });

  try {
    let raw: unknown;

    try {
      raw = await execute(
        parsed.value,
        extendInvocation(call, {
          callId: ticket.request.callId,
          name: ticket.entry.tool.name,
          caller: ticket.caller,
          plan: ticket.plan,
          ...(ticket.execution ? { execution: ticket.execution } : {}),
          progress: progress.send,
        }) as ToolInvocation,
      );
    } catch {
      return fail("execution-failed");
    }

    const delivered = await progress.finish();

    if (!delivered.ok) return delivered;

    const result = normalizeResult(raw);

    if (!result.ok) {
      if (
        result.error &&
        typeof result.error === "object" &&
        "source" in result.error &&
        result.error.source === "core"
      )
        return result as ToolsResult<never>;

      const error = readError(result.error);
      return error.ok ? { ok: false, error: error.value } : fail("invalid-output");
    }

    const output = readOutput(result.value, limits.maxOutputBytes);

    if (!output.ok) return output;

    if (outputSchema && (!output.value.structured || !outputSchema(output.value.structured)))
      return fail("invalid-output");

    return output;
  } finally {
    await progress.finish();
    progress.close();
  }
}
