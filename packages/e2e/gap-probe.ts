// 到达节奏直印探针：真端点直连，chunk 到达即打印（观感=到达节奏，显示层零加工）；
// error finish 打到 stderr——失败不再静默（曾因请求体 model 字段错误而只收到 error finish）。
// 用法：GLM_API_KEY=... [GLM_BASE_URL=...] [GLM_MODEL=...] bun packages/e2e/gap-probe.ts
import { createAi } from "@x-harness/llm";
const modesConfig: Record<string, {
  baseUrl?: string,
  apiKey?: string,
  model?: string,
  apiType:'openai-completions'|'anthropic-messages'
}> = {
  'deepseek': {
    baseUrl:process.env.DEEPSEEK_BASE_UR,
    apiKey: process.env.DEEPSEEK_APIPKEY,
    model: process.env.DEEPSEEK_MODEL,
       apiType:'openai-completions'
  },
  'glm': {
    baseUrl:process.env.GLM_BASE_URL,
    apiKey: process.env.GLM_API_KEY,
    model: process.env.GLM_MODEL,
       apiType:'anthropic-messages'
  },
  'tg': {
    baseUrl:process.env.TG_BASE_URL,
    apiKey: process.env.TG_API_KEY,
    model: process.env.TG_MODEL,
    apiType:'openai-completions'
  }
}
const model = modesConfig['tg']

if (!model.baseUrl || !model.apiKey||!model.model) {
    throw Error(`not found model${JSON.stringify(model)}`)
}

const adapter = createAi(model.apiType,{
  baseUrl: model.baseUrl,
  apiKey: model.apiKey,
});


for await (const chunk of adapter.stream({
  model:model.model,
  maxTokens: 2048,
  tools: [],
  thinking: 'high',
  temperature: 0,
  messages: [{ role: "user", content: [{ type: "text", text: "你是谁" }] }] as never,
  signal: new AbortController().signal,
})) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  }

  if (chunk.type === 'usage') {
       process.stdout.write(JSON.stringify(chunk.usage))
  }

  if (chunk.type === 'finish') {
     process.stdout.write(JSON.stringify(chunk.finish))
  }
}
