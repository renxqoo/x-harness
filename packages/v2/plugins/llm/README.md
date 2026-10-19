# LLM 插件

统一的模型请求、流消息和最终结果。模型协议由独立的提供者插件实现；LLM 不执行工具、不保存会话。

```ts
import { createHost } from "@x-harness/core";
import { createLlmPlugin, defineLlmProvider, llm, streamLlm } from "@x-harness/llm";
import { createOpenaiPlugin } from "@x-harness/llm-openai";

const token = defineLlmProvider("primary");
if (!token.ok) throw new Error("Invalid provider");
const provider = createOpenaiPlugin({
  api: "responses",
  token: token.value,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "provided-by-your-configuration",
  models: { "your-model": { input: ["text", "image"], output: ["text", "json-schema"] } },
});
const plugin = createLlmPlugin({ providers: { primary: token.value }, defaultProvider: "primary" });
const opened = createHost({ limits: { callTimeoutMs: 180000 } });
if (!opened.ok || !provider.ok || !plugin.ok) throw new Error("Invalid configuration");
const app = opened.value;
try {
  const installed = await app.install([provider.value, plugin.value]);
  if (!installed.ok) throw new Error("Installation failed");
  const selected = app.use(llm);
  if (!selected.ok) throw new Error("LLM unavailable");
  const stream = streamLlm(selected.value, {
    model: "your-model",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  });
  for await (const event of stream) {
    if (event.type === "text-delta") process.stdout.write(event.delta);
    if (event.type === "tool-call" && event.call.input.ok) {
      console.log(event.call.name, event.call.input.value);
    }
  }
  const result = await stream.result;
  if (!result.ok) console.error(result.error.code);
} finally {
  await app.close();
}
```

需要完整结果使用 `generate(request)`，返回 `{ ok: true, value }` 或 `{ ok: false, error }`。`value.content` 保留有序内容块、工具、引用、推理 continuation；`value.output` 是通过 JSON/schema 校验的结果。`describe({ model, provider? })` 返回配置的能力，不访问网络。模型名和能力必须由宿主配置，插件不猜测模型版本。

`stream({ ...request, onEvent })` 等待每次回调，整个流结束才完成。`streamLlm` 在首次 `next()` 才发请求，单消费者、最多一个待消费事件。先遍历，再检查 `result`；只等未启动的 `result` 不会发请求。预先或随后取消 signal 可直接结算未启动的流。`break` 会取消；已经保存的流句柄在结束时释放输入与服务引用。

所有事件都有本地 `requestId` 和递增 `sequence`。消息事件为 `start`、`response-info`、`block-start`、`text-delta`、`refusal-delta`、`reasoning-delta`、`signature-delta`、`tool-call-delta`、`tool-call`、`continuation`、`citation`、`provider-event`、`block-end`、`usage`、`finish`、`error`。增量按块 ID 归属；工具完成事件紧接在块结束前。`input.ok` 仅证明完整 JSON 对象，上层还需验证工具 schema、结束原因、权限并决定是否执行。

JSON/schema 校验在 `finish` 前完成，流式和完整输出的成功条件相同。拒绝、过滤、截断保留各自结束原因。`continuation` 是绑定提供者、协议及模型的原生续接数据；不要当正文显示或跨模型回放。URL 引用、输入文档 `sourceId` 和提供者文件 `fileId` 有不同身份。累计 `usage` 应替换已有计数，不能逐事件相加；输入包含缓存读写明细，推理属于输出明细。

默认无重试、无等待队列。总并发 32、提供者并发 16，满即 `busy`；输入/输出各 16MiB，单事件 1MiB，工具参数 256KiB，续接数据 512KiB。总期限 180s，同时受宿主更短期限约束；响应头 30s、读取无进展 60s、消费者 30s。取消立即通知网络，实际未结束的任务仍占容量。不合作的回调需要宿主进程监督。`hasOutput` 告知失败前是否有内容，不能据此自动推断重试安全。

扩展提供者：用 `defineLlmProvider` 创建 token，普通 `definePlugin({ provides: { provider: token } })` 可以通过 `ctx.service({ provider: ... })` 实现公开 `LlmProviderService`，无需专用插件工厂。也可以使用 `llm/provider` 的 `createLlmProviderPlugin({ token, models, run })` 提供服务。`run(input, context)` 按顺序 await `input.onEvent(event)`，返回明确 `ProviderEnd`，不能自行发布 start/finish/error。公共工厂统一处理容量、请求快照、取消、描述与回调撤销。使用 `llm/testing` 的 `verifyLlmProvider({ service, provider, request, expected: { kind: "text" } })` 按指定 text/tool-call 场景检查标准内容、描述、状态机、背压和预取消，不能用任意 provider-event 代替标准内容；真实网络的超时、资源排空及厂商能力仍需作者专项测试。

`llmRequest` 是声明依赖后使用的请求策略 chain，输入 `{ request, onEvent, collect }`，输出 `{ summary, content?, output? }`。策略可以包装回调、显式选择路由，不应在已经输出内容后隐式重试。

本仓库的 Bun 构建产物与源码共享公共契约及 core 定义元数据，支持源码与构建插件混合装配。构建目录依赖同包源码契约，部署时应保留完整包目录，或由应用打包器整体打包；不能只复制 dist 目录。默认测试运行真实回环 HTTP，不访问厂商付费接口。

可以从 [提供者作者完整示例](PROVIDERS.md) 开始实现自己的插件；该示例和调用示例都经过公开入口类型检查。

可选线上文本连通检查：显式配置 `LLM_API`（responses/chat-completions/anthropic-messages）、`LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL` 后，在工作区执行 `bun run test:llm:live`。该命令会调用指定付费接口，只验证给定配置的文本流与正常结束；默认四门不会执行，也不代表全部模态认证。密钥不写入报告或代码。
