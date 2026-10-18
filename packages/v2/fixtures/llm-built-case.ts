import { createLlmServer, sse } from "./llm-server";
const root = new URL("../", import.meta.url);
const load = (path: string) => import(new URL(path, root).href);
const core = await load("core/dist/index.js"); const llmModule = await load("plugins/llm/dist/index.js"); const contracts = await load("plugins/llm/dist/contracts.js"); const openai = await load("plugins/llm-openai/dist/index.js"); const anthropic = await load("plugins/llm-anthropic/dist/index.js");
function value<T>(result: import("../plugins/llm/src/contracts").LlmResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
if (contracts.llm !== llmModule.llm) throw new Error("split token");
const server = createLlmServer(); const host = value<import("../core/src/index").Host>(core.createHost());
try {
  const chat = value(llmModule.defineLlmProvider("built-chat")); const responses = value(llmModule.defineLlmProvider("built-responses")); const messages = value(llmModule.defineLlmProvider("built-messages"));
  value(await host.install([value(openai.createOpenaiPlugin({ api: "chat-completions", token: chat, baseUrl: server.baseUrl, apiKey: "test", models: { m: {} } })), value(openai.createOpenaiPlugin({ api: "responses", token: responses, baseUrl: server.baseUrl, apiKey: "test", models: { m: {} } })), value(anthropic.createAnthropicPlugin({ token: messages, baseUrl: server.baseUrl, apiKey: "test", models: { m: { maxOutputTokens: 100 } } })), value(llmModule.createLlmPlugin({ providers: { chat, responses, messages } }))]));
  const service = value(host.use(contracts.llm as import("../core/src/index").ServiceToken<import("../plugins/llm/src/contracts").LlmService>)); const input = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as const;
  for (const provider of ["chat", "responses", "messages"]) {
    let scene: unknown[]; if (provider === "chat") scene = [{ choices: [{ delta: { content: "built" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]; else if (provider === "responses") scene = [{ type: "response.created", response: { id: "r" } }, { type: "response.completed", response: { id: "r", status: "completed" } }]; else scene = [{ type: "message_start", message: { id: "r", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }];
    server.scene({ chunks: scene.map((event) => sse(event)) }); const response = value(await service.generate({ ...input, provider })); if (response.reason.kind !== "stop" || response.provider !== provider) throw new Error("invalid final response");
  }
  if (server.requests.length !== 3 || host.inspect().activeTasks || host.inspect().activeCalls) throw new Error("work did not drain");
} finally { value(await host.close()); await server.close(); }
process.stdout.write("built protocols passed\n");
