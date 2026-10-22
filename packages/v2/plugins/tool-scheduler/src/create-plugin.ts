import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import { tools } from "../../tools/src/index";
import { toolScheduler, toolScheduleAccess } from "./contracts";
import type { BatchReport, SchedulerOptions, SchedulerResult } from "./contracts/types";
import { data, keys } from "./domain/read-values";
import { readLimits } from "./domain/read-limits";
import { readRequest } from "./domain/read-request";
import { fail } from "./domain/fail";
import { createRuntime } from "./runtime/create-runtime";
import { runBatch } from "./runtime/run-batch";
import { stopBatch } from "./runtime/stop-batch";
import { pumpQueue } from "./runtime/pump-queue";
import type { Batch, SchedulerCall } from "./runtime/types";

export function createToolSchedulerPlugin(raw: SchedulerOptions = {}): SchedulerResult<Plugin> {
  const d = data(raw);

  if (
    !d ||
    !keys(d, ["access", "limits"]) ||
    (d.access !== undefined && !["required", "allow"].includes(d.access as string))
  )
    return fail("invalid-input");

  const limits = readLimits(d.limits);

  if (!limits.ok) return limits;

  return {
    ok: true,
    value: definePlugin({
      name: "tool-scheduler",
      requires: { tools },
      provides: { toolScheduler, access: toolScheduleAccess },
      async setup(ctx) {
        const runtime = createRuntime(limits.value);
        const watched = await ctx.deps.tools.watch({
          onChange() {
            runtime.revision++;
            runtime.wake();
          },
        });

        if (!watched.ok) return watched;

        const unwatch = ctx.addCleanup(watched.value);

        if (!unwatch.ok) {
          await watched.value();
          return unwatch;
        }

        const cleanup = ctx.addCleanup(() => {
          runtime.closed = true;

          for (const batch of runtime.batches) stopBatch(runtime, batch, fail("closed"));

          runtime.queue = [];
          runtime.lanes.length = 0;
          runtime.streak.clear();
          return { ok: true, value: undefined };
        });

        if (!cleanup.ok) return cleanup;

        if (d.access === "allow") {
          const allow = ctx.guard("access", () => ({ ok: true, value: { kind: "allow" } }));

          if (!allow.ok) return allow;
        }

        const submit = async (
          raw: unknown,
          batch: boolean,
          call: SchedulerCall,
        ): Promise<SchedulerResult<BatchReport>> => {
          const parsed = readRequest(raw, batch, limits.value);

          if (!parsed.ok) return parsed;

          const input = parsed.value;

          if (runtime.closed) return fail("closed");

          if (
            runtime.requests >= limits.value.maxRequests ||
            runtime.outstanding + input.calls.length > limits.value.maxOutstandingCalls
          )
            return fail("queue-full");

          runtime.requests++;
          runtime.outstanding += input.calls.length;
          let state: Batch | undefined;
          const task = call.spawn({
            label: "tool-schedule-request",
            signal: input.signal,
            timeoutMs: input.timeoutMs,
            run: (child) =>
              runBatch(runtime, {
                input,
                origin: call.origin,
                call: child,
                created(value) {
                  state = value;
                },
              }),
          });

          if (!task.ok) {
            runtime.requests--;
            runtime.outstanding -= input.calls.length;
            return task;
          }

          try {
            const result = await call.wait(task.value);

            if (
              !result.ok &&
              result.error.source === "core" &&
              (result.error.code === "timeout" || result.error.code === "cancelled")
            )
              call.cancel(result.error.code);

            return result;
          } finally {
            await task.value.finished;
            runtime.requests--;

            if (state) {
              state.off();
              runtime.batches.delete(state);
            } else runtime.outstanding -= input.calls.length;

            pumpQueue(runtime);
          }
        };

        return ctx.service({
          toolScheduler: {
            async execute(input, call) {
              const result = await submit(input, false, call);
              return result.ok ? result.value.results[0]!.result : result;
            },
            batch: (input, call) => submit(input, true, call),
            async inspect(input) {
              const d = data(input);

              if (!d || Object.keys(d).length) return fail("invalid-input");

              return {
                ok: true,
                value: {
                  running: runtime.running,
                  queued: runtime.queue.length + runtime.checking + runtime.committing,
                  requests: runtime.requests,
                },
              };
            },
          },
        });
      },
    }),
  };
}
