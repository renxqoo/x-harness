import { createHost } from "../core/src/index";
import { createLlmPlugin, defineLlmProvider, llm } from "../plugins/llm/src/index";
import { createOpenaiPlugin } from "../plugins/llm-openai/src/index";
import { createAnthropicPlugin } from "../plugins/llm-anthropic/src/index";
import type { LlmResult } from "../plugins/llm/src/contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const api = process.env.LLM_API;
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;

if (
  !baseUrl ||
  !apiKey ||
  !model ||
  !["responses", "chat-completions", "anthropic-messages"].includes(api ?? "")
)
  throw new Error(
    "Required explicit LLM_API, LLM_BASE_URL, LLM_API_KEY and LLM_MODEL configuration",
  );

const host = value(createHost({ limits: { callTimeoutMs: 180000 } }));
const token = value(defineLlmProvider("live-check"));

try {
  const options = { token, baseUrl, apiKey, models: { [model]: {} } };
  const provider =
    api === "anthropic-messages"
      ? createAnthropicPlugin(options)
      : createOpenaiPlugin({ ...options, api: api as "responses" | "chat-completions" });
  value(
    await host.install([
      value(provider),
      value(createLlmPlugin({ providers: { selected: token }, defaultProvider: "selected" })),
    ]),
  );
  const service = value(host.use(llm));
  const result = value(
    await service.generate({
      model,
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply with a short greeting." }] },
      ],
      maxOutputTokens: 64,
      timeoutMs: 180000,
    }),
  );
  const textBytes = result.content
    .filter((block) => block.block.kind === "text")
    .reduce((bytes, block) => bytes + new TextEncoder().encode(block.text ?? "").length, 0);

  if (result.reason.kind !== "stop" || !textBytes)
    throw new Error("Live text probe did not complete normally");

  process.stdout.write(
    JSON.stringify({
      ok: true,
      protocol: result.response.protocol,
      reason: result.reason,
      textBytes,
      usage: result.usage,
    }) + "\n",
  );
} finally {
  value(await host.close());
}
