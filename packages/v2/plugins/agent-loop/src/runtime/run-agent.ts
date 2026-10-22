import { maximumSchedulerLimits } from "../../../tool-scheduler/src/index";
import type { AgentCall, RunProgress } from "./types";
import type {
  AgentCaller,
  AgentLimits,
  AgentResult,
  AgentRun,
  AgentCheckpoint,
  AgentStopReason,
} from "../contracts/types";
import type { LlmMessage, LlmResponse, LlmUsage } from "../../../llm/src/index";
import type { RunRequest } from "../domain/read-request";
import type { AgentEmitter } from "./create-emitter";
import { readLlmRequest } from "../../../llm/src/validation";
import { validateToolInput } from "../../../tools/src/validation";
import { readJson } from "../domain/read-json";
import { fail } from "../domain/fail";
import { mapResponse } from "../domain/map-response";
import { prepareContext } from "./prepare-context";
import { createModelSink } from "./create-model-sink";
import { runTools } from "./run-tools";

export async function runAgent(args: {
  call: AgentCall;
  source: RunRequest;
  caller: AgentCaller;
  limits: AgentLimits;
  emit: AgentEmitter;
  progress: RunProgress;
}): Promise<AgentResult<AgentRun>> {
  const { call, source, caller, limits, emit } = args;
  let messages = source.request.messages,
    toolCalls = 0;
  const usage: { step: number; usage: LlmUsage }[] = [],
    seen = new Set<string>();
  collectIds(messages, seen);

  for (let step = 1; step <= limits.maxSteps; step++) {
    args.progress.step = step;
    const prepared = await prepareContext({ call, source, caller, step, messages, limits });

    if (!prepared.ok) return prepared;

    const { context, catalog } = prepared.value;
    collectIds(context.request.messages, seen);

    if (seen.size > limits.maxMessages + limits.maxToolCalls) return fail("capacity-exceeded");

    if (step === 1) {
      const started = await emit.send({ type: "start", model: context.request.model });

      if (!started.ok) return started;
    }

    const entered = await emit.send({ type: "step-start", step });

    if (!entered.ok) return entered;

    const sink = createModelSink(emit, step);
    let modeled;

    try {
      modeled = await call.dispatch(
        "llmRequest",
        {
          request: { ...context.request, signal: sink.signal },
          collect: true,
          onEvent: sink.onEvent,
        },
        { signal: sink.signal },
      );
    } finally {
      sink.close();
    }

    if (emit.error()) return emit.error()!;

    if (!modeled.ok || !modeled.value.content) return fail("model-failed");

    const response: LlmResponse = Object.freeze({
      ...modeled.value.summary,
      content: modeled.value.content,
      ...(modeled.value.output !== undefined ? { output: modeled.value.output } : {}),
    });
    usage.push({ step, usage: response.usage });
    const mapped = mapResponse(response);

    if (!mapped.ok) return mapped;

    if (mapped.value.calls.length > maximumSchedulerLimits.maxBatchCalls)
      return fail("capacity-exceeded");

    for (const tool of mapped.value.calls) {
      if (
        seen.has(tool.callId) ||
        !catalog.has(tool.name) ||
        !tool.input.ok ||
        !validateToolInput(catalog.get(tool.name)!, tool.input.value).ok
      )
        return fail("invalid-model-output");

      seen.add(tool.callId);
    }

    const next = Object.freeze([
      ...messages,
      ...(mapped.value.message ? [mapped.value.message] : []),
    ]);
    const checkpoint: AgentCheckpoint = Object.freeze({
      ...context,
      phase: "response",
      response,
      messages: next,
    });

    if (
      next.length + mapped.value.calls.length > limits.maxMessages ||
      !readJson(next, limits.maxTranscriptBytes).ok ||
      !readJson(checkpoint, limits.maxTranscriptBytes * 3).ok
    )
      return fail("capacity-exceeded");

    const saved = await call.dispatch("agentCheckpoint", checkpoint);

    if (!saved.ok) return fail("checkpoint-failed");

    if (!mapped.value.calls.length) return complete("model", { messages: next, response, step });

    if (step >= limits.maxSteps) return complete("step-limit", { messages, response, step });

    if (toolCalls + mapped.value.calls.length > limits.maxToolCalls)
      return complete("tool-limit", { messages, response, step });

    const tools = await runTools({
      call,
      checkpoint,
      calls: mapped.value.calls,
      emit,
      limits,
      progress: args.progress,
    });
    toolCalls += mapped.value.calls.length;

    if (!tools.ok) return tools;

    messages = tools.value.messages;

    if (
      !readLlmRequest(
        { model: context.request.model, messages },
        { maxInputBytes: limits.maxTranscriptBytes, maxMessages: limits.maxMessages },
      ).ok
    )
      return fail("capacity-exceeded", { toolsMayHaveRun: true });

    const ended = await emit.send({
      type: "step-end",
      step,
      reason: response.reason,
      toolCalls: mapped.value.calls.length,
    });

    if (!ended.ok) return ended;

    const continued = await call.dispatch("agentContinue", tools.value.checkpoint);

    if (!continued.ok) return fail("context-failed", { toolsMayHaveRun: true });

    if (continued.value.kind !== "allow")
      return complete("policy", { messages, response, step }, false);
  }

  return fail("invalid-output");

  async function complete(
    stopReason: AgentStopReason,
    state: { messages: readonly LlmMessage[]; response: LlmResponse; step: number },
    end = true,
  ): Promise<AgentResult<AgentRun>> {
    if (
      !readLlmRequest(
        { model: state.response.model, messages: state.messages },
        { maxInputBytes: limits.maxTranscriptBytes, maxMessages: limits.maxMessages },
      ).ok
    )
      return fail("capacity-exceeded");

    if (end) {
      const ended = await emit.send({
        type: "step-end",
        step: state.step,
        reason: state.response.reason,
        toolCalls: 0,
      });

      if (!ended.ok) return ended;
    }

    const result: AgentRun = Object.freeze({
      runId: source.runId,
      steps: state.step,
      toolCalls,
      messages: state.messages,
      response: state.response,
      stopReason,
      usage: Object.freeze(usage),
    });
    const finished = await emit.send({ type: "finish", stopReason, steps: state.step, toolCalls });
    return finished.ok ? { ok: true, value: result } : finished;
  }
}

function collectIds(messages: readonly LlmMessage[], seen: Set<string>) {
  for (const message of messages)
    if (message.role === "assistant")
      for (const block of message.content) if (block.type === "tool-call") seen.add(block.callId);
}
