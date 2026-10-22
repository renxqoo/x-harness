import type { AgentCall, RunProgress } from "./types";
import type { AgentCheckpoint, AgentResult, AgentLimits } from "../contracts/types";
import type { LlmToolCall, LlmMessage } from "../../../llm/src/index";
import type { AgentEmitter } from "./create-emitter";
import { mapResults } from "../domain/map-results";
import { readJson } from "../domain/read-json";
import { fail } from "../domain/fail";

export async function runTools(args: {
  call: AgentCall;
  checkpoint: AgentCheckpoint;
  calls: readonly LlmToolCall[];
  emit: AgentEmitter;
  limits: AgentLimits;
  progress: RunProgress;
}): Promise<AgentResult<{ checkpoint: AgentCheckpoint; messages: readonly LlmMessage[] }>> {
  const allowed = await args.call.dispatch("agentRunAccess", {
    runId: args.checkpoint.runId,
    step: args.checkpoint.step,
    caller: args.checkpoint.caller,
    request: args.checkpoint.request,
    ...(args.checkpoint.metadata ? { metadata: args.checkpoint.metadata } : {}),
    phase: "tools",
  });

  if (!allowed.ok || allowed.value.kind !== "allow") return fail("access-denied");

  const { step } = args.checkpoint;
  const sink = progressSink(args.emit, step);
  let result;
  args.progress.toolsMayHaveRun = true;

  try {
    result = await args.call.deps.toolScheduler.batch({
      signal: sink.signal,
      calls: args.calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        input: call.input.ok ? call.input.value : {},
      })),
      onProgress: sink.onProgress,
    });
  } finally {
    sink.close();
  }

  const failed = args.emit.error();

  if (failed) return fail(failed.error.code, { toolsMayHaveRun: true });

  if (!result.ok) return fail("tool-batch-failed", { toolsMayHaveRun: true });

  if (
    result.value.results.length !== args.calls.length ||
    result.value.results.some((item, index) => item.callId !== args.calls[index]!.callId)
  )
    return fail("tool-batch-failed", { toolsMayHaveRun: true });

  const mapped = mapResults(result.value);
  const checkpoint: AgentCheckpoint = Object.freeze({
    ...args.checkpoint,
    phase: "tools",
    messages: Object.freeze([...args.checkpoint.messages, ...mapped.messages]),
    results: Object.freeze(mapped.results),
  });

  if (
    !readJson(checkpoint.messages, args.limits.maxTranscriptBytes).ok ||
    !readJson(checkpoint, args.limits.maxTranscriptBytes * 3).ok
  )
    return fail("capacity-exceeded", { toolsMayHaveRun: true });

  const saved = await args.call.dispatch("agentCheckpoint", checkpoint);

  if (!saved.ok) return fail("checkpoint-failed", { toolsMayHaveRun: true });

  if (mapped.unknown) return fail("tool-outcome-unknown", { toolsMayHaveRun: true });

  if (args.emit.error()) return args.emit.error()!;

  return { ok: true, value: { checkpoint, messages: checkpoint.messages } };
}

function progressSink(emitter: AgentEmitter, step: number) {
  let current: AgentEmitter | undefined = emitter;
  const controller = new AbortController();
  return {
    signal: controller.signal,
    onProgress: async (event: { readonly callId: string; readonly delta: string }) => {
      const result = await current?.send({ type: "tool-progress", step, ...event });

      if (result && !result.ok) {
        controller.abort();
        emitter.cancel();
      }
    },
    close() {
      current = undefined;
      controller.abort();
    },
  };
}
