import { createHost } from "../../../../core/src/index";
import type { Plugin, Result } from "../../../../core/src/index";
import { createLlmPlugin, defineLlmProvider } from "../../../llm/src/index";
import { createLlmProviderPlugin } from "../../../llm/src/provider";
import type {
  ProviderStreamInput,
  ProviderEnd,
  LlmResult,
  ProviderEvent,
  ModelDescription,
} from "../../../llm/src/index";
import { createToolsPlugin } from "../../../tools/src/index";
import type { SchedulerOptions } from "../../../tool-scheduler/src/index";
import { createToolSchedulerPlugin } from "../../../tool-scheduler/src/index";
import { createAgentLoopPlugin, agentLoop } from "../index";
import type { AgentOptions } from "../index";

export function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const request = {
  model: "test",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
} as const;
export const model: ModelDescription = {
  model: "test",
  protocol: "test",
  input: ["text", "image", "document", "search-result"],
  developer: true,
  tools: true,
  citations: true,
  output: ["text", "json", "json-schema"],
  providerTools: [],
  reasoning: { efforts: ["high"], budget: true, display: ["text", "summary", "hidden"] },
};

export async function send(input: ProviderStreamInput, events: readonly ProviderEvent[]) {
  for (const event of events) value(await input.onEvent(event));
}

export async function answer(
  input: ProviderStreamInput,
  text = "answer",
): Promise<LlmResult<ProviderEnd>> {
  await send(input, [
    { type: "block-start", block: { id: "text", kind: "text" } },
    { type: "text-delta", id: "text", delta: text },
    { type: "block-end", id: "text", status: "complete" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, complete: true } },
  ]);
  return { ok: true, value: { reason: { kind: "stop" } } };
}

export async function toolTurn(
  input: ProviderStreamInput,
  calls: readonly { name: string; callId: string; input?: unknown }[],
): Promise<LlmResult<ProviderEnd>> {
  for (const [index, call] of calls.entries()) {
    const id = `tool${index}`;
    await send(input, [
      { type: "block-start", block: { id, kind: "tool-call" } },
      { type: "tool-call-delta", id, field: "callId", delta: call.callId },
      { type: "tool-call-delta", id, field: "name", delta: call.name },
      { type: "tool-call-delta", id, field: "input", delta: JSON.stringify(call.input ?? {}) },
      { type: "block-end", id, status: "complete" },
    ]);
  }

  return { ok: true, value: { reason: { kind: "tool-calls" } } };
}

export async function world(
  options: {
    plugins?: readonly Plugin[];
    agent?: AgentOptions;
    scheduler?: SchedulerOptions;
    schedulerPlugin?: Plugin;
    run?: (input: ProviderStreamInput) => Promise<LlmResult<ProviderEnd>>;
  } = {},
) {
  const host = value(
    createHost({ limits: { maxCallDepth: 256, callTimeoutMs: 3000, closeTimeoutMs: 300 } }),
  );
  const provider = value(defineLlmProvider("test"));
  const installed = await host.install([
    value(createToolsPlugin({ access: "allow" })),
    options.schedulerPlugin ??
      value(createToolSchedulerPlugin({ access: "allow", ...options.scheduler })),
    value(
      createLlmProviderPlugin({
        token: provider,
        models: { test: model },
        run: options.run ?? ((input) => answer(input)),
      }),
    ),
    value(createLlmPlugin({ providers: { test: provider }, defaultProvider: "test" })),
    ...(options.plugins ?? []),
    value(createAgentLoopPlugin({ access: "allow", ...options.agent })),
  ]);

  if (!installed.ok) {
    await host.close();
    throw new Error(JSON.stringify(installed.error));
  }

  return { host, service: value(host.use(agentLoop)), installed: installed.value };
}

export async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
