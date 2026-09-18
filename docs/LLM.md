# LLM 件方案（runtime + openai-compat 流式适配器）——回炉重写

> 状态：已实施（回炉重写；代码审查 4×P1+8×P3 处置见 §5）
> 级别：中（新外部契约、网络 I/O 语义；消费方为 agent-loop）
> 上游：docs/AGENT-LOOP.md §3/§4 与处置 P14。参照 DSH 的 llm/stream waterfall 思想；
> 砍掉 prepareCall/adapterDefaults 分层（无第二适配器前不需要——用户裁决）。

## 1. 契约

### 1.1 类型

```ts
export interface TokenUsage { readonly input?: number; readonly output?: number }
export type LlmFinish =
  | { readonly kind: "stop" }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "error"; readonly message: string; readonly code?: string; readonly retryAfterMs?: number };
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
  /** 恰一个 finish 收尾（P14：无 finish 流按 error 结算归 loop 兜底；适配器违约自担测试） */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface LlmRuntime {
  registerAdapter(adapter: LlmAdapter): () => void;   // 重名 throw；Disposer 注册方自负 effect
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}
```

### 1.2 失败契约（本版澄清——前版自相矛盾处根治）

适配器失败两形态，loop（settleStream）统一按 attempt 结算：

1. **abort**：`signal` 已断/中途断 → throw `AbortError` 语义（驱动按 aborted 收尾，不进 retry）。
2. **其余一切失败**（连接拒绝、HTTP 非 2xx、读体中断、**EOF 未见 finish 的截断流**）：适配器 yield
   `{type:"finish", finish:{kind:"error", message, code, retryAfterMs?}}` 收尾流——**不裸 throw**。
   code 词表（闭集）：`http-<status>`（如 `http-429`）、`network`（连接拒绝/读体中断/EOF 截断——
   截断归网络类可重试；适配器在流自然结束且未发过 finish 时补 `finish{error, code:"network",
   message:"stream ended without finish"}`，驱动的无-finish 兜底仅防违约适配器）、`no-adapter`。
   `retryAfterMs` 仅 HTTP 429/503 带 `Retry-After` 头（秒，小数折算；HTTP-date 形态解析失败视为
   缺席）时出现——重试件的快车道输入。

理由：code/retryAfter 必须一路流到 `agentRequestError` 载荷（RequestFailure），重试件才能判
retryableCodes 与退避快车道；裸 throw 丢结构（前版 RequestFailure 只有 message，code 断流）。

### 1.3 服务与 token（归一层与派发时机）

- `llmRuntime` 服务：registerAdapter + `stream(request)`——**经 `llm/stream` waterfall 派发**
  （中间件位：回放/路由/计量后续挂此），final = 解析适配器（provider 匹配名；缺省唯一）→
  `adapter.stream(request)`；未解析 → 产出 `finish{kind:"error", code:"no-adapter",
  message:"no-adapter:<provider|none-registered|ambiguous-N>"}` 收尾流（消费方 fail-closed：
  一次错误结算而非悬挂）。final 内适配器**同步** throw 同样归一为单 finish 错误流
  （code:"network"——适配器违约自担，消费者不接裸 throw）。
- runtime.stream 实现为 async 生成器：`try { yield* inner } catch (e) { if (request.signal.aborted
  || finalSignal.aborted || isAbortLike(e)) throw e; yield finish{error, code:"network"} }`——异步
  reject/敌意迭代器异常归一为 error finish；**abort 豁免**（AbortError 或原始/最终 signal 任一已断
  → rethrow，驱动按 aborted 收尾不进 retry——中间件换 signal 的窗口由 finalSignal 兜住）。for-await
  提前 break 的 return() 经生成器协议正确委托内层。
- 已知语义（落档）：违约适配器在 yield finish 后再 throw 时，归一层补第二条 network finish——
  消费方 StreamAccumulator 按 last-wins 结算为错误（「恰一个 finish」由守卫在守约流上保证）。
- **语义变更（落档）**：生成器体惰性——派发时机从「调 stream() 即派发」变为「首次 next() 才派发」；
  唯一消费者（agent-loop）取流后紧跟 for-await，无感。

### 1.4 openai-compat 适配器（`createOpenaiCompatAdapter({ name?, baseUrl, apiKey, fetch? })`；插件 `createOpenaiCompatLlm` inject ["llm"]）

- POST `{baseUrl}/chat/completions`：`stream:true` + `stream_options:{include_usage:true}`；
  `fetch` 可注入（测试用真 fetch + 本地 http 服务器）。
- **请求前 abort**：`signal.throwIfAborted()`。
- **连接拒绝/DNS**：catch → yield `finish{error, code:"network", message}`。
- **HTTP 非 2xx**：读体（失败降级空串）→ yield `finish{error, code:"http-<status>", message:体摘要200字,
  retryAfterMs?:429/503 的 Retry-After 秒×1000}`。
- **读体中断**（网络断）：catch → yield `finish{error, code:"network"}`。
- SSE 解析（行缓冲跨 read 拼接；`TextDecoder {stream:true}` 多字节防撕裂；EOF 终 flush 残量再排空）：
  - 行协议：`data: <json>`；`data: [DONE]` → 停读（`reader.cancel()` 释连接）；
  - 注释行（`:` 前缀）/`event:`/`id:` 行跳过；CRLF 由 trimEnd 吸收；空 payload 跳过。
  - `choices[0].delta.content` → text-delta；`delta.tool_calls[].{index,id,function.{name,arguments}}` →
    tool-call-delta（index 首现带 callId/name）；`usage` → usage；`finish_reason`（stop/tool_calls/未知→stop、
    length→max-tokens）→ finish **恰一次**（守卫；usage 帧可在 finish 后继续到达）。
- 消息转换（SurfaceMessage → OpenAI）：system→system；user→user（仅 text 块拼接，P14）；
  assistant→assistant（text 拼接 + tool_use → tool_calls[]；空文本且有 tool_calls → content:null）；
  tool→tool（tool_call_id=callId + content）。
- 工具表：ToolSchema → `{type:"function",function:{name,description?,parameters}}`（TypeBox 序列化自动丢符号键）。

## 2. 问题域

**处理**：适配器注册/解析（no-adapter 错误结算）；llm/stream waterfall；SSE 硬化解析与格式转换；
失败契约（code/retryAfterMs 结构化透出）。
**不处理**：重试策略本体（LLM-RETRY 件）；用量记账（TOKEN-METER 件）；非 OpenAI 兼容协议；计费。

## 3. 测试口径（对照参考语义子集 S15–S21/S44–S46/P6–P10/P16 的真缺口）

- runtime：重名 throw/disposer 注销（身份守卫——注销后可重注册）；provider 命中/未命中 no-adapter
  **错误结算**（不向消费者 throw）；缺省唯一/零/多适配器；适配器同步 throw 与异步 reject 任意值
  （非 Error）都归一为 error finish（S16）；下游 for-await 提前 break → 内层 return() 被正确等待与
  委托、清理失败外抛恰一次（S21）；waterfall 中间件改写流（包装 chunks）/透传/中间件 throw 传播
  （不吞不改写，S20）。
- openai-compat（本地 HTTP 假服务器，表驱动 SSE 脚本，**分片写响应体制造撕裂**）：
  - 流解析：纯文本流/工具调用分片聚合（index 首现带 callId/name）/usage（含 finish 后到达的 usage 帧
    ——恰一次 finish 守卫）/finish_reason 三态（stop/tool_calls/length→max-tokens）/[DONE] 停读且
    reader.cancel 释放连接/CRLF 行尾/注释行（`:` 前缀）与 `event:`/`id:` 行跳过/多字节 UTF-8 跨片撕裂/
    EOF 残量终 flush（半行 JSON 帧不丢）；
  - 失败映射：非 2xx → `http-<status>` code + 体摘要 + 429/503 的 Retry-After（小数秒折算、0 合法）
    → retryAfterMs；连接拒绝 → `network`；读体中断 → `network`；请求前已 abort → throw AbortError；
  - 消息转换：四角色表（system/user 仅 text 拼接/assistant text+tool_calls 且空文本有工具调用 →
    content:null/tool 结果 tool_call_id 对齐）；畸形防御（null content 归一空串、未知块跳过——降级不崩，
    P16/S51 对照）；
  - 工具表序列化含 description；无工具不落 tools 键。
- 契约：token 词表锁定；组装器（agent-loop StreamAccumulator）已由件5覆盖分片聚合幂等。

## 4. 验收清单

- [x] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告（见提交说明）

## 5. 代码审查处置（回炉批，4×P1+8×P3）

P1 EOF 半行帧丢失（终 flush 只认换行）→ drainFinalLine 整行处理 + 回归；P1 [DONE] 不停读 +
releaseLock 后 cancel 无效 → 停读标志 + 先 cancel 再释放 + 连接释放回归；P1 δ/2ⁿ 子序按 sort
惰性求值分配（前向引用错序）→ 注册序预热；P1 重试预算键缺 session（跨会话互烧）→ 键含 session +
sessionDisposed 回收。P3：message 三重前缀（只给体摘要）；HTTP-date 解析（过去=0）；abort 豁免
两段对称（finalSignal）；归一层双 finish 落档；下游异常 stderr 留痕；封存会话 fail-closed；
meter 冻结深度与溢出 O(1) 短路；adapter-plugin 覆盖。
