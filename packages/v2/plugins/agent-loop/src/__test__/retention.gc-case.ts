import { definePlugin } from "../../../../core/src/index";
import type { AgentLoopService, AgentRunInput } from "../index";
import { streamAgent } from "../index";
import { llmRequest } from "../../../llm/src/index";
import type { LlmStreamInput } from "../../../llm/src/index";
import { world, value, request } from "./helpers";
let saved: LlmStreamInput["onEvent"] | undefined;
const capture = definePlugin({
  name: "capture",
  requires: { llmRequest },
  setup: (ctx) =>
    ctx.middleware("llmRequest", (input, next) => {
      saved = input.onEvent;
      return next(input);
    }),
});
const f = await world({ plugins: [capture] });
const kept: unknown[] = [];
const refs: WeakRef<object>[] = [];

try {
  await run();
  await iterate();
  const until = Date.now() + 1500;

  while (Date.now() < until) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    if (refs.every((ref) => !ref.deref())) break;
  }

  if (refs.some((ref) => ref.deref()))
    throw new Error("closed agent entry retains callback, input or service");

  const before = kept.length;
  await saved?.(
    { type: "text-delta", id: "late", delta: "late", requestId: "late", sequence: 1 },
    new AbortController().signal,
  );

  if (kept.length !== before) throw new Error("late callback emitted output");

  process.stdout.write("agent retention passed\n");
} finally {
  value(await f.host.close());
}

async function run() {
  let callback: AgentRunInput["onEvent"] | undefined = () => {};

  let input: AgentRunInput | undefined = { ...request, onEvent: callback };
  refs.push(new WeakRef(callback), new WeakRef(input));
  value(await f.service.run(input));
  callback = undefined;
  input = undefined;
}

async function iterate() {
  let service: AgentLoopService | undefined = { run: (input) => f.service.run(input) };
  let input: AgentRunInput | undefined = { ...request };
  refs.push(new WeakRef(service), new WeakRef(input));
  const stream = streamAgent(service, input);

  for await (const event of stream)
    if (event.type === "error") throw new Error("unexpected stream failure");

  value(await stream.result);
  kept.push(stream);
  service = undefined;
  input = undefined;
}
