// 到达节奏直印探针：真端点直连，chunk 到达即打印（观感=到达节奏，显示层零加工）。
// 用法：GLM_API_KEY=... [GLM_BASE_URL=...] [GLM_MODEL=...] bun packages/e2e/gap-probe.ts
import { createAnthropicCompatAdapter } from "@x-harness/llm";

const adapter = createAnthropicCompatAdapter({
  baseUrl: process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic",
  apiKey: process.env.GLM_API_KEY ?? "",
});
for await (const chunk of adapter.stream({
  model: process.env.GLM_MODEL ?? "glm-4.6",
  maxTokens: 2048,
  tools: [],
  messages: [{ role: "user", content: [{ type: "text", text: "写一篇300字短文，介绍长江" }] }] as never,
  signal: new AbortController().signal,
})) {
  if (chunk.type === "thinking-delta" || chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  }
}
