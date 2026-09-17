# LLM Runtime 设计（件 C：词表所有者）

> 状态：**讨论中，未写实现代码**。[DESIGN.md](./DESIGN.md) §3.2 六件套之 C 件；通过「词表测试」进内核——StreamChunk、思考档词表、错误终态是所有参与方的公共语言。
> 契约一句话：**无状态适配器注册表 + prepareCall 解析即快照；拨号是请求期数据，不是实例状态。**

## 1. LlmRuntime 契约

```ts
interface LlmRuntime {
  registerAdapter(providers: readonly string[], adapter: LlmAdapter): Disposer
  resolveModel(provider: string, model: string): Result<ModelInfo, string>
  prepareCall(config: CallConfig, signal?: AbortSignal): Promise<Result<PreparedCall, string>>
}

interface PreparedCall {
  stream(request: CallRequest): AsyncIterable<StreamChunk>   // 只可派发一次
  readonly model: ModelInfo                                   // 解析出的元数据（快照绑定）
}
```

- **拨号是请求期数据，不是实例状态**：Runtime 不携带「当前模型」；每次调用的 provider/model/思考档在请求组装时从读链解析（LOOP.md §1）。
- **prepareCall = 解析即快照**：把适配器实例 + 元数据 + maxTokens 绑定进 PreparedCall，之后调用不再回查注册表；`stream` 只可派发一次。dsh 的代际绑定/原子 replace 是为桌面热替换（HMR）竞态付的内核复杂度——我们无 HMR 场景（dsh 坑 P4）：注册句柄 dispose 后新调用走新注册，在途 PreparedCall 自然完成，不建热替换协议。

## 2. 适配器（插件提供）

```ts
abstract class LlmAdapter {
  resolveModel(provider: string, model: string): ModelInfo | undefined
  abstract stream(call: PreparedCall, request: CallRequest): AsyncIterable<StreamChunk>
}
```

- `llm-pi`：wire 层外包给 pi-ai；`llm-faux`：确定性剧本适配器（测试地基）。
- fallback 降级链 / 成本路由：以适配器组合形态存在于 Runtime 之下，对上层不可见。done/finish 终态回填实际拨号方——账本归属的事实来源。
- 重试：`llm/stream` 瀑布的**出厂默认监听器**（内核发货即装，可用性内建 D12；插件可盖写策略，不能移除兜底）。

## 3. StreamChunk 协议与思考档

- 块边界标记 + 增量（text / reasoning / tool-call）+ usage + finish（stopReason + 实际拨号方回填）+ **error 终态**（流绝不 throw）。
- 思考档词表（off/low/medium/high）与 budget 常量从 my-agent 移植；档位 × 模型能力校验在 prepareCall（不支持 → 拒；未指定 → 物化适配器默认）。

## 4. 总线词表（llm 件拥有）

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `llm/stream` | waterfall | 入 `{ call: PreparedCall, request: CallRequest }`；出 `AsyncIterable<StreamChunk>` | none | **重试插件的挂靠面**；final = 适配器真实调用（owner 是本件；loop 与 side 调用方都是 dispatcher）。**side 调用（压缩摘要等）经同一 token dispatch（自带 final）——自动继承重试与观察**；直连 preparedCall.stream 绕过重试属违规 |
| `llm/chunk` | emit（agent 链） | `StreamChunk` | **none（高频豁免）** | UI 流式显示的观察面。**生产者 = 流消费者**：loop 发主调用的块；side 调用默认不发射（进度走 `plugin/event` 信封），避免双流污染 UI |

## 5. 决策引用

D3/D4（拨号折叠、无状态注册表）· D12（重试出厂默认）· dsh 坑 P4（代际绑定简化）。

## 6. 待讨论（M2 前收口）

- StreamChunk 块类型全集、错误码集、retryable 判定归谁（适配器 or 重试中间件）
- **CallConfig / CallRequest / CallDraft 三形**的精确关系（CallDraft 是 compose 瀑布的草案面，见 LOOP.md）
- 思考档能力校验的报错面（拒在 prepareCall 还是流 error 终态）
- CallRequest 的 attributes 透传面（traceparent 下行）——远期
