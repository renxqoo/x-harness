# Agent loop

一次有界的模型与工具循环。输入完整对话，输出可继续使用的消息、最后模型响应、每轮用量和停止原因。模型通过公开 llmRequest 链请求；工具统一经过 tool-scheduler、tools 权限、参数校验和资源协调。循环不依赖数据库或特定模型厂商。

```ts
import { createHost } from "@x-harness/core";
import { createLlmPlugin, defineLlmProvider } from "@x-harness/llm";
import { createOpenaiPlugin } from "@x-harness/llm-openai";
import { createToolsPlugin, createToolPlugin } from "@x-harness/tools";
import { createToolSchedulerPlugin } from "@x-harness/tool-scheduler";
import { createAgentLoopPlugin, agentLoop, streamAgent } from "@x-harness/agent-loop";

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("Operation failed");
  return result.value;
}
const provider = value(defineLlmProvider("primary"));
const app = value(createHost({ limits: { callTimeoutMs: 180000, maxCallDepth: 256 } }));
try {
  value(
    await app.install([
      value(
        createOpenaiPlugin({
          api: "chat-completions",
          token: provider,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "provided-by-your-configuration",
          models: { "your-model": {} },
        }),
      ),
      value(createLlmPlugin({ providers: { primary: provider }, defaultProvider: "primary" })),
      value(createToolsPlugin({ access: "allow" })),
      value(createToolSchedulerPlugin({ access: "allow" })),
      value(
        createToolPlugin({
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          async execute(input) {
            return { ok: true, value: { content: [{ type: "text", text: input.text }] } };
          },
        }),
      ),
      value(createAgentLoopPlugin({ access: "allow" })),
    ]),
  );
  const stream = streamAgent(value(app.use(agentLoop)), {
    model: "your-model",
    tools: ["echo"],
    messages: [{ role: "user", content: [{ type: "text", text: "Use echo to say hello" }] }],
  });
  for await (const event of stream) {
    if (event.type === "model-event" && event.event.type === "text-delta") {
      process.stdout.write(event.event.delta);
    }
  }
  const result = await stream.result;
  if (result.ok) process.stdout.write(`\n${result.value.stopReason}\n`);
} finally {
  value(await app.close());
}
```

示例的三个 access:allow 是宿主显式信任委托。受控应用保持默认 required，并分别配置 agentRunAccess、toolScheduleAccess、toolAccess、toolExecutionAccess。运行关口保留原始调用者 origin/initiator；工具服务实际看到调度器委托身份，完整工具授权仍由 tools 负责。见 [扩展与持久化](EXTENDING.md)。

## 运行与结果

直接使用 agentLoop.run(input) 可通过 onEvent(event,signal) 接收等待背压的流。tools 未给时发现可见目录；tools:[] 禁用本地工具；给名称数组只提供指定工具。工具 schema 来自公开目录，不接受调用者伪造。每轮重新发现；上下文插件只能缩减工具集合和保持同名 schema。真正执行时 tools 再次校验及授权。

模型输入参数沿用 LlmRequest：model、provider、messages、reasoning、temperature、topP、maxOutputTokens、stop、output、providerOptions、providerTools、toolChoice。signal 与 timeoutMs 控制整个运行；上下文插件的 timeoutMs 只限制单次模型请求，不能突破运行剩余期限。metadata 是最多64KiB的 JSON 对象，只传给扩展与检查点，不自动进入模型请求；业务标签不是可信身份。runId 可选，默认随机生成，仅在本实例运行期间防止同名并发，不是永久幂等键。

成功结果包含 runId、steps、toolCalls、messages、response、usage 和 stopReason。model 表示保留模型原始结束原因后结束，仍须检查 response.reason：length/refusal/content-filter/pause/other 不等同于正常文本完成；policy 表示继续关口拒绝；step-limit/tool-limit 表示未提交下一批工具。预算不足时不部分提交工具；未执行或未完成的 assistant 工具调用只留在 response，不写进可恢复 messages。usage 每轮一份，不累加流中的累计事件，不伪造缺失计数。response 保留引用、原生续接数据及结构化结果。

仅在模型完整结束为 tool-calls、全部块完成、参数完整且整批满足当前 schema、callId 未在历史或本次执行中出现、名称属于本轮目录时提交。不会从工具参数增量直接执行。整批预检针对本轮目录 schema 和公开 JSON 硬预算，不预留运行时权限或额度；工具替换、权限撤销或更低的实际工具预算仍可能在其他节点执行后失败，不能当作整批事务回滚。工具结果按调用顺序成对回填；文本/图片保真，structured 追加为 JSON 文本，空输出补空文本。工具正常返回的 isError 是已确认回执；Result 失败被保守标记 unknown，保存回执后停止为 tool-outcome-unknown，不再让模型尝试重放。整批失败为 tool-batch-failed，也不隐式重试。

## 流事件

AgentEvent 的 type 是 start、step-start、model-event、tool-progress、step-end、finish、error。所有事件有 runId 和从 0 递增的 sequence；轮次事件有从 1 开始的 step。model-event.event 保留原 LlmEvent 词表、requestId 和 sequence，模型的 tool-call 只表示生成调用，不能当作实际已执行。tool-progress 用 callId 区分并行工具。

参数校验或容量准入失败直接返回 Result。正常运行只有一个最后的 finish；已经进入运行且事件通道仍可用时，失败以 error 结束。消费者异常/超时、预算耗尽或调用已经取消时不能承诺送达终态。agentEvent 是同一事件的 core 通知，继承有界队列与观察者隔离，不作为持久确认。宿主 onEvent 是等待背压接口；首次失败立即请求取消当前模型/工具批次，不继续提交后续工作。

streamAgent 在首次 next 才调用服务；先遍历再 await result。未消费的 result 不会启动运行，显式 signal 仍能取消。只有一个消费者、一个未消费事件；break/return/throw 取消，重复消费者或并发 next 返回 consumer-failed。结束后清除输入、服务及回调引用。原始自定义服务仍须响应 signal，流接口不能强杀任意 JavaScript。

## 错误与资源边界

AgentError.code 为 invalid-input、invalid-output、capacity-exceeded、busy、closed、access-denied、context-failed、model-failed、invalid-model-output、checkpoint-failed、tool-batch-failed、tool-outcome-unknown、consumer-failed、cancelled、timeout。错误不回显底层异常文本。业务失败带 runId、已知 step；首次提交工具后，后续失败保留 toolsMayHaveRun:true。core 也可能直接返回取消/超时 CoreFault，其回执先于实际函数结束，缺少业务字段不证明未发生副作用。

单轮调用最多256项，复用 tool-scheduler 的公开硬上限；实际调度器的默认批次上限为128，配置可更低。超过硬上限在执行前拒绝，合法的大批次不会在执行后因回执计数失配而丢失检查点。

默认最多 8 个运行、16 次模型调用、64 次工具调用、128 个工具、512 条 transcript 消息、上下文及 transcript 4MiB。单事件 1MiB、累计 16MiB/100000 条；检查点序列化最多 transcript 预算三倍。期限 180s、消费者 30s，均受宿主更短期限约束。JSON 深度最多 64、节点最多 200000，callId 索引最多 maxMessages+maxToolCalls。配置入口为 createAgentLoopPlugin({access?,limits?})，未知字段、非安全正整数及超出硬上限的配置拒绝。

硬上限依次为 64 个运行、128 步、1024 次工具调用、128 工具、4096 消息、16MiB transcript、4MiB 单事件、64MiB/1000000 事件、1800s 运行、300s 消费者。模型/工具/调度器还有自己的独立预算。满额立即 busy，没有隐式后台队列。取消或卸载请求终止，实际函数退出前继续占用额度、任务和工具资源；不合作代码需要宿主监督。

运行本身不包含消息收件箱、上下文压缩、自动重试、数据库及跨机器调度。检查点插件负责业务保存与恢复判断；会话间并发、同会话串行及多节点独占由宿主或独立协调插件管理。源码和构建产物共享公开契约，部署保留完整包布局或整体打包。

## 在线多步验收

在 `packages/v2` 显式配置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 后执行 `bun run test:agent:live`，使用 Chat Completions 协议调用真实付费接口。可选 `LLM_REASONING_EFFORT` 传递该模型明确支持的推理档位；省略时不发送档位参数。脚本显式声明可接收文本推理，不按模型名选择行为，密钥只从环境读取。

验收要求模型先读取缺失报告，从工具业务错误恢复，再读取发票、通过 execution-local 执行固定计算程序、保存并复读文件，最后给出精确 JSON 结果。随后关闭宿主、重开 SQLite，从完整检查点继续对话；计算和写入只能各执行一次。脚本核对可见答复、流事件顺序、工具回执、持久化内容、调度队列及关闭后的工作和资源归零。进程环境不继承模型凭据，所有测试文件写入独立临时目录并在结束后清理。

该验收每次 Agent 运行期限300秒，模型响应头与空闲期限各90秒；不会自动重试失败请求。输出逐轮进度及最终步数、工具数、事件数、检查点数、用量和耗时。服务端无通道、超时或模型不完成指定任务都会使命令失败，不能以网络连通代替 Agent 通过。默认测试通过真实回环 HTTP 运行同一旅程，另外检查服务不可用、错误参数、仅推理包含结果及错误最终金额，默认四门不调用外部模型。

此验收证明指定配置下的有界 Agent 闭环，不覆盖收件箱、压缩、重试、委派、标准文件工具包、长期压力或跨节点恢复。

宿主 onEvent 抛错会取消整次受管调用，立即返回 core cancelled；消费者超时返回 core timeout。这样即使模型或工具忽略 signal，调用方也能结束等待；实际工作排空前保留运行额度。取消回执不携带 AgentError 的副作用字段，恢复必须查已保存的调用意图。consumer-failed 仍用于流接口消费协议错误与未启动成功的消费者任务，不能据此推断远端执行已结束。

模型或工具在途的事件验证/预算失败同样取消整次调用，返回 core cancelled，防止忽略 signal 的执行拖住失败回执；尚未发起模型的预算失败仍返回 capacity-exceeded。
