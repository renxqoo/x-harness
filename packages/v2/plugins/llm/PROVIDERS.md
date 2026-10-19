# 编写提供者插件

普通插件可通过公开的LlmProviderService与ctx.service提供模型服务。下面是可选受管工厂的完整示例，提供一个确定性的本地文本服务。真实模型适配器只需把网络事件映射为相同的块与增量，认证、模型能力和连接清理由各适配器负责。

```ts
import { createHost } from "@x-harness/core";
import { createLlmPlugin, defineLlmProvider, llm } from "@x-harness/llm";
import { createLlmProviderPlugin } from "@x-harness/llm/provider";
import { verifyLlmProvider } from "@x-harness/llm/testing";
import type { ProviderEvent } from "@x-harness/llm/contracts";

const token = defineLlmProvider("local-text");
if (!token.ok) throw new Error("Invalid token");
const provider = createLlmProviderPlugin({
  token: token.value,
  models: {
    local: {
      protocol: "local-text",
      model: "local",
      input: ["text"],
      developer: false,
      tools: false,
      citations: false,
      output: ["text"],
      providerTools: [],
    },
  },
  async run(input) {
    const events: readonly ProviderEvent[] = [
      { type: "block-start", block: { kind: "text", id: "answer" } },
      { type: "text-delta", id: "answer", delta: "hello" },
      { type: "block-end", id: "answer", status: "complete" },
    ];
    for (const event of events) {
      const sent = await input.onEvent(event);
      if (!sent.ok) return sent;
    }
    return { ok: true, value: { reason: { kind: "stop" } } };
  },
});
const plugin = createLlmPlugin({ providers: { local: token.value }, defaultProvider: "local" });
const opened = createHost();
if (!provider.ok || !plugin.ok || !opened.ok) throw new Error("Invalid configuration");
const app = opened.value;
try {
  const installed = await app.install([provider.value, plugin.value]);
  if (!installed.ok) throw new Error("Installation failed");
  const backend = app.use(token.value);
  if (!backend.ok) throw new Error("Provider unavailable");
  const request = { model: "local", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as const;
  await verifyLlmProvider({ service: backend.value, provider: "local", request, expected: { kind: "text", text: "hello" } });
  const selected = app.use(llm);
  if (!selected.ok) throw new Error("LLM unavailable");
  const response = await selected.value.generate(request);
  if (!response.ok) throw new Error(response.error.code);
  console.log(response.value.content);
} finally {
  await app.close();
}
```

`run` 必须等待每次 `onEvent`；回调失败立即返回同一个 Result。提供者只提交中间事件并返回明确结束原因，统一层负责请求身份、序号、标准工具完成事件和最终校验。真实 I/O 使用 `input.signal`，并在返回前等待 reader/连接实际关闭，不能把网络放进未受管的后台 Promise。工厂同时提供模型描述、并发准入、调用取消和回调撤销。

工具输入用 `tool-call-delta` 的 `callId`、`name`、`input` 三种字段逐片提交，再提交 `block-end`；不要自行解析参数或发布标准 `tool-call` 完成事件。提供者不执行客户端工具。不认识且会影响语义的事件明确拒绝，不能全部塞进 `provider-event` 冒充标准内容。

检查器必须声明预期标准内容：`{ kind: "text", text? }` 或 `{ kind: "tool-call", name, input? }`。它验证给定请求的状态、标准输出、慢消费者路径和预取消；完整覆盖各模态、网络故障、关闭排空与线上模型能力仍需作者的专项测试。
