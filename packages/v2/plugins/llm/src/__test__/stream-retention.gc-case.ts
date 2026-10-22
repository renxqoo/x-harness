import { streamLlm } from "../index";
import type { LlmService, LlmRequest } from "../contracts";

async function create() {
  const service: LlmService = {
    async stream() {
      return {
        ok: false,
        error: { source: "llm", code: "closed", phase: "close", hasOutput: false },
      };
    },
    async generate() {
      throw new Error("unused");
    },
    async describe() {
      throw new Error("unused");
    },
  };
  const request: LlmRequest = {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(100000) }] }],
  };
  const stream = streamLlm(service, request);

  for await (const event of stream) void event;

  await stream.result;
  return { stream, request: new WeakRef(request), service: new WeakRef(service) };
}

const kept = await create();

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 0));
  Bun.gc(true);
}

if (kept.request.deref() || kept.service.deref())
  throw new Error("completed stream retains source");

if (!(await kept.stream.result).ok) process.stdout.write("released\n");
