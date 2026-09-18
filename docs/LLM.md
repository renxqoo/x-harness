# LLM 件方案（runtime + openai-compat 流式适配器）

> 状态：定稿
> 级别：中（新外部契约、网络 I/O 语义；消费方为 agent-loop）
> 上游：docs/AGENT-LOOP.md §3/§4。参照 DSH 的 llm/stream waterfall 思想；砍掉 prepareCall/adapterDefaults 分层（无第二适配器前不需要——用户裁决：不复制）。

## 1. 契约

### 1.1 类型

```ts
export interface TokenUsage { readonly input?: number; readonly output?: number }
export type LlmFinish = { readonly kind: "stop" } | { readonly kind: "max-tokens" } | { readonly kind: "error"; readonly message: string; readonly code?: string };
export type LlmChunk =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly callId?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly finish: LlmFinish };

export interface LlmRequest {
  readonly model: string;
  readonly provider?: string;          // 适配器选择键；缺省 = 唯一注册适配器
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools: readonly ToolSchema[];
  readonly messages: readonly SurfaceMessage[];   // 恒 = session.deriveMessages()（loop 侧不变量）
  readonly signal: AbortSignal;
}

export interface LlmAdapter {
  readonly name: string;
  /** 恰一个 finish 收尾（审查处置 P14：无 finish 流按 error 结算归 loop 兜底；适配器违约自担测试） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  registerAdapter(adapter: LlmAdapter): () => void;   // 重名 throw；Disposer 注册方自负 effect
  stream(request: LlmRequest): Promise<void>;          // 消费 AsyncIterable？——见 1.2
}
```

### 1.2 服务与 token

- `llmRuntime` 服务：registerAdapter + `stream(request): AsyncIterable<LlmChunk>`——**经 `llm/stream` waterfall 派发**（中间件位：重试/回放/路由后续挂此），final = 解析适配器（provider 匹配名；缺省唯一）→ `adapter.stream(request)`；未解析到适配器 → throw `no-adapter:<provider>`（调用方 fail-closed）。
- 适配器内 HTTP 错误（连接失败/非 2xx）→ throw（错误信息含 status 与响应体摘要）；流中错误 → yield `{type:"finish", finish:{kind:"error"}}` 收尾。

### 1.3 openai-compat 适配器（`createOpenaiCompatLlm({ name?, baseUrl, apiKey, fetch? })`，inject ["llm"]）

- POST `{baseUrl}/chat/completions`：`stream:true` + `stream_options:{include_usage:true}`；`fetch` 可注入（测试假服务器用真 fetch + 本地 http server）。
- SSE 解析：逐行 `data: <json>` / `data: [DONE]`；`choices[0].delta.content` → text-delta；`delta.tool_calls[].{index,id,function.{name,arguments}}` → tool-call-delta（index 首现带 callId/name）；`usage` → usage；`finish_reason`（stop/length/tool_calls→stop）→ finish。length → max-tokens。
- 消息转换（SurfaceMessage → OpenAI）：system→system；user→user（仅 text 块拼接）；assistant→assistant（text 拼接 + tool_use 块 → tool_calls[]）；tool→tool（tool_call_id + content）。
- 工具表：ToolSchema → `{type:"function",function:{name,description?,parameters}}`（TypeBox schema 序列化自动丢符号键）。

## 2. 问题域

**处理**：适配器注册/解析；llm/stream waterfall；openai-compat SSE 流解析与格式转换。
**不处理**：重试策略（后续插件挂 agent/request-error）；非 OpenAI 兼容协议；usage 计费；限流。

## 3. 测试口径

- 契约：token 词表（2 个）；registerAdapter 重名 throw/disposer；no-adapter throw。
- waterfall：中间件可改写流（包装 chunks）、final 透传、逃逸 throw 传播。
- openai-compat（本地 HTTP 假服务器，表驱动 SSE 脚本）：纯文本流/工具调用分片聚合/usage/finish_reason 三态/[DONE]/非 2xx throw 带状态码/连接拒绝 throw/消息转换表（四角色+tool_use）/工具表序列化含 description。
- abort：请求前 signal 已 abort → throw AbortError 语义。

## 4. 验收清单

- [ ] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告
