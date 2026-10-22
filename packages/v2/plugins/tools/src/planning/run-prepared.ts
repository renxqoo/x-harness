import { signalAborted } from "../../../../core/src/validation";
import { checkPermission } from "./check-permission";
import type { Invocation } from "../../../../core/src/index";
import { createExecutionFacade } from "./create-execution-facade";
import { createDispatchRequest } from "../contributions/create-request";
import { runTool } from "../execution/run-tool";
import { fail } from "../domain/fail";
import { propagateCancellation } from "../execution/propagate-cancellation";
import { preparedCells, capacityCells, commitCells } from "./shared";
import { checkPlan } from "./check-plan";
import { closePlan } from "./close-plan";
import type { PlanningRuntime } from "./state";
import type { PreparedToolRequest } from "./types";
import type { ToolsResult, ToolOutput } from "../contracts/types";

export async function runPrepared(
  runtime: PlanningRuntime,
  input: PreparedToolRequest,
  options: { call: Invocation; originId: string },
): Promise<ToolsResult<ToolOutput>> {
  const { call, originId } = options;
  const state = preparedCells.get(input.prepared)?.current;

  if (!state) return checkPlan(input.prepared) as ToolsResult<never>;

  if (state.runtime.deref() !== runtime || state.originId !== originId)
    return fail("access-denied");

  if (input.commit) {
    const commit = commitCells.get(input.commit);

    if (!commit || commit.state.deref() !== state || commit.originId !== originId)
      return fail("access-denied");

    commitCells.delete(input.commit);
  } else {
    const checked = await checkPermission(input.prepared, call, originId);

    if (!checked.ok) return checked;
  }

  const status = checkPlan(input.prepared);

  if (!status.ok) return status;

  if (signalAborted(call.signal) || (input.signal && signalAborted(input.signal))) {
    closePlan(state, "cancelled");
    return fail("cancelled");
  }

  if (status.value === "waiting") return fail("resource-busy");

  const capacities = [...new Set(input.capacities ?? [])];

  if (capacities.some((x) => !capacityCells.has(x))) return fail("invalid-input");

  if (capacities.some((x) => capacityCells.get(x)!.active >= x.limit))
    return fail("admission-busy");

  if ((runtime.toolActive.get(state.entry.id) ?? 0) >= state.entry.tool.concurrency) {
    closePlan(state);
    return fail("busy");
  }

  if (
    state.phase !== "pending" ||
    signalAborted(state.entry.signal) ||
    runtime.closed ||
    preparedCells.get(input.prepared)?.current !== state ||
    state.permissions.some((x) => x.signal && signalAborted(x.signal))
  )
    return fail("closed");

  state.phase = "running";
  runtime.pending.delete(input.prepared);
  preparedCells.get(input.prepared)!.current = undefined;
  state.capacities = capacities;

  for (const capacity of capacities) capacityCells.get(capacity)!.active++;

  runtime.active.add(state);
  runtime.toolActive.set(state.entry.id, (runtime.toolActive.get(state.entry.id) ?? 0) + 1);

  const cancel = (reason: "cancelled" | "timeout") => {
    call.cancel(reason);
  };

  let executionCell: ReturnType<typeof createExecutionFacade> | undefined;
  const task = call.spawn({
    label: "prepared-tool",
    signal: input.signal,
    timeoutMs: Math.min(
      input.timeoutMs ?? state.request.timeoutMs ?? runtime.limits.timeoutMs,
      runtime.limits.timeoutMs,
      state.entry.limits.timeoutMs,
    ),
    async run(child) {
      executionCell = state.plan.execution
        ? createExecutionFacade(child, state.plan.execution)
        : undefined;
      const execution = executionCell?.facade;

      if (input.onStart) {
        try {
          input.onStart();
        } catch {
          return fail("consumer-failed");
        }
      }

      const effective = Object.freeze(
        Object.fromEntries(
          Object.entries(runtime.limits).map(([key, n]) => [
            key,
            Math.min(n, state.entry.limits[key as keyof typeof state.entry.limits]),
          ]),
        ) as unknown as typeof runtime.limits,
      );
      return runTool({
        ticket: {
          entry: state.entry,
          request: {
            ...state.request,
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          },
          caller: state.plan.origin,
          cancel,
          plan: state.plan,
          execution,
        },
        call: child as Invocation,
        limits: effective,
        inputSchema: state.entry.compiled.input,
        outputSchema: state.entry.compiled.output,
        async execute(value, invocation) {
          const dispatch = createDispatchRequest({
            ownerSignal: state.entry.signal,
            name: state.entry.tool.name,
            callId: state.request.callId,
            input: value as import("../contracts/types").JsonObject,
            caller: state.plan.origin,
            plan: state.plan,
            progress: invocation.progress,
            ...(execution ? { execution } : {}),
          });

          try {
            const result = await child.dispatch("toolDispatch", dispatch.request);

            if (
              !result.ok &&
              result.error &&
              typeof result.error === "object" &&
              "source" in result.error &&
              "code" in result.error &&
              result.error.source === "core"
            ) {
              if (result.error.code === "callback-failed") return fail("execution-failed");

              if (result.error.code === "invalid-result") return fail("invalid-output");
            }

            return result;
          } finally {
            dispatch.close();
          }
        },
      });
    },
  });

  if (task.ok)
    state.cancel = (reason) => {
      call.cancel(reason ?? "cancelled");
    };

  try {
    return task.ok ? propagateCancellation(await call.wait(task.value), cancel) : task;
  } finally {
    if (task.ok) await task.value.finished;

    executionCell?.close();
    executionCell = undefined;
    runtime.active.delete(state);
    const count = runtime.toolActive.get(state.entry.id)! - 1;

    if (count) runtime.toolActive.set(state.entry.id, count);
    else runtime.toolActive.delete(state.entry.id);

    for (const capacity of capacities) capacityCells.get(capacity)!.active--;

    closePlan(state);
  }
}
