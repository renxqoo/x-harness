// 到达节奏直印探针：真端点直连，chunk 到达即打印（观感=到达节奏，显示层零加工）；
// error finish 打到 stderr——失败不再静默（曾因请求体 model 字段错误而只收到 error finish）。
// 用法：GLM_API_KEY=... [GLM_BASE_URL=...] [GLM_MODEL=...] bun packages/e2e/gap-probe.ts
import { createAnthropicCompatAdapter } from "@x-harness/llm";
const isDeepSeek = false
const model = {
  baseUrl: isDeepSeek?process.env.DEEPSEEK_BASE_URL :process.env.GLM_BASE_URL ,
  apiKey: isDeepSeek?process.env.DEEPSEEK_APIPKEY:process.env.GLM_API_KEY,
  model: isDeepSeek?process.env.DEEPSEEK_MODEL:process.env.GLM_MODEL
}

if (!model.baseUrl || !model.apiKey) {
    throw Error(`not found model${JSON.stringify(model)}`)
}

const adapter = createAnthropicCompatAdapter({
  baseUrl: model.baseUrl,
  apiKey: model.apiKey,

});
for await (const chunk of adapter.stream({
  model:model.model ?? "glm-4.6",
  maxTokens: 2048,
  tools: [],
  thinking: 'high',
  temperature:0.1,
  messages: [{ role: "user", content: [{ type: "text", text: "你是谁" }] }] as never,
  signal: new AbortController().signal,
})) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  }
}
