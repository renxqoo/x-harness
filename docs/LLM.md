# LLM 件方案（runtime + openai-compat 流式适配器）——回炉重写

> 状态：已实施（回炉重写 + anthropic 支持；代码审查处置见 §5/§6/§7）
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
  | { readonly type: "thinking-delta"; readonly text: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly callId?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly finish: LlmFinish };

export interface LlmRequest {
  readonly model: string;
  readonly provider?: string;          // 适配器选择键；缺省 = 唯一注册适配器
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinking?: ThinkingLevel;   // off/low/medium/high；缺省/off 不发 thinking 参数
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
  （中间件位——@x-harness/llm-replay-guard 挂此：上游断流从头重发的容错，docs/LLM-REPLAY-GUARD.md）
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

### 1.4 协议适配器（wire 委托 @earendil-works/pi-ai——docs/LLM-PI.md）

两工厂 `createAnthropicCompatAdapter({ name?, baseUrl, apiKey, fetch?, maxTokensDefault?, contextWindow?, streamFn? })`
与 `createOpenaiCompatAdapter({ name?, baseUrl, apiKey, fetch?, contextWindow?, streamFn? })`（插件
`createAnthropicCompatLlm`/`createOpenaiCompatLlm` inject ["llm"]）。自研 wire（http-dial/sse-scan/
anthropic-request/两旧适配器）已删——SSE 解析、流式 tool-call 分片、供应商怪癖归 pi-ai 的
**api-level stream**（不走 Models：provider 注册门 + env 鉴权门与手配 baseUrl/apiKey 形态不兼容）。

**适配器职责（pi-adapter.ts）**：
- Model 条目**按请求构造**：`id/name = request.model`（请求体 model 字段来源——适配器名只作 provider
  注册键，绝不进请求体）；api `anthropic-messages`（POST `{baseUrl}/v1/messages`，pi 追加 `?beta=true`）
  / `openai-completions`（POST `{baseUrl}/chat/completions`）；
- options：`apiKey`；`headers:{"accept-encoding":"identity"}`（SSE 恒不协商压缩——运行时默认协商
  会换来无逐块 flush 的 gzip/br，透明解压把流攒成大坨）；`maxRetries:0`（单 attempt，重试职责在
  llm-retry——SDK 缺省 2 必须显式归零）；`cacheRetention:"none"`（wire 无 cache_control）；`signal`；
  anthropic 侧 maxTokens 恒注入（协议必填：`request.maxTokens ?? maxTokensDefault ?? 8192`），
  openai 侧仅显式才发；`temperature?`；思考等级注入（仅 anthropic-messages）：low/medium/high →
  `thinkingEnabled:true + effort + thinkingBudgetTokens`（2048/8192/16384），缺省/off 不发；`fetch`（用户注入的 fetch 经**非 2xx 捕获包装**：状态码与
  `retry-after`（秒/HTTP-date）/`retry-after-ms`（毫秒语义直取）头在此确定性捕获——pi 的
  onResponse 只在成功路径触发，错误状态在 SDK 内即 throw）；
- 同步 throw（鉴权缺失等）折算 error finish（文案分类）；请求前 abort → throw AbortError。

**消息映射（pi-context.ts）**：system 顶层化（多条 `\n\n` 拼接）；user 仅 text 块、空 user 整条
跳过；assistant text/tool_use（input STRING→JSON.parse 降 `{}`）；tool 消息 → toolResult（toolName
前文 tool_use 回查、查无 "unknown"；isError 透传）；工具表 `{name, description(必填——pi 契约，
缺席空串), parameters}`；孤立 tool_use 合成空结果、相邻合并等 wire 级配对归 pi transform-messages。

**事件映射（pi-events.ts）**：终态恰一次；`text/thinking_delta` → 对应 delta chunk（空串跳过）；
- P10 初值（anthropic 方言 `emitStartInitials`）：`text/thinking_start` 的 partial 非空初值补发 delta
  （openai 恒不读——pi 在同一同步块里把首帧 append 进 partial，读到的必是已变异值）；
- toolcall：**出口单帧**——`toolcall_end` 携带完整调用（id/name/arguments），end 时发一帧
  `{index: contentIndex, callId, name, argumentsDelta: 全量 JSON 文本}`（index 为 pi **稠密**索引
  ——语义变更：不再是 wire 原值稀疏；消费方按 index 聚积兼容）；start/delta 分片不透传
  （x-harness 无工具分片消费者——流帧只广播 text/thinking，累积器只关心最终 input）；
- `done` → usage（**cacheRead+cacheWrite 折入 input**——GLM 桥自动缓存不低计；全零不发）+ finish
  （length→max-tokens，stop/toolUse/deferred→stop）；
- `error` → abort（reason aborted / signal 已断）throw AbortError（豁免）；先发 usage（`error.usage`
  ——失败尝试的 input 账不丢，token-meter 计费依赖）再发 error finish（捕获状态在场落
  `http-<status>`，否则文案分类：词边界状态码匹配防数值子串误杀；refusal/sensitive/content_filter
  与鉴权文案落无 code 不可重试；网络词族落 network）；
- `text/thinking_end` 终态校正：wire 尾段未被 delta 覆盖时补发。

**语义变更（相对旧自研 wire，docs/LLM-PI.md 语义变更清单）**：toolcall index 稠密化；中途 usage 帧
消失（usage 只在终态事件携带，字段级合并归 pi 内部）；redacted_thinking 由跳过改为广播
"[Reasoning redacted]" 思考块；SSE 停读/连接释放/ping/CRLF/字节撕裂防守随 wire 删除移交 pi，
真身冒烟（pi-wire.test.ts：非 2xx/retry-after 三态/中途断连/连接拒绝/请求头与请求体硬化断言）
在默认门内防守。

**e2e:real（§3 同变）**：env 三变量 + `PROTOCOL` 常量（缺省 openai）；provider 名与 adapter.name
精确一致；BASE_URL 语义随协议（`/v1/messages` vs `/chat/completions`）。

## 2. 问题域

**处理**：适配器注册/解析（no-adapter 错误结算）；llm/stream waterfall；pi-ai 事件/消息双向映射；
失败契约（code/retryAfterMs 结构化透出——状态与 retry-after 在 fetch 包装层捕获）。
**不处理**：重试策略本体（LLM-RETRY 件）；用量记账（TOKEN-METER 件）；计费。
（前版「不处理：非 OpenAI 兼容协议」作废——用户裁决：必须支持 Anthropic 协议，见 §1.5。）

## 3. 测试口径（对照参考语义子集 S15–S21/S44–S46/P6–P10/P16 的真缺口）

- runtime：重名 throw/disposer 注销（身份守卫——注销后可重注册）；provider 命中/未命中 no-adapter
  **错误结算**（不向消费者 throw）；缺省唯一/零/多适配器；适配器同步 throw 与异步 reject 任意值
  （非 Error）都归一为 error finish（S16）；下游 for-await 提前 break → 内层 return() 被正确等待与
  委托、清理失败外抛恰一次（S21）；waterfall 中间件改写流（包装 chunks）/透传/中间件 throw 传播
  （不吞不改写，S20）。
- 协议适配器三层装置（docs/LLM-PI.md 测试口径）：
  - 注入层（工厂 `streamFn?` 注入事件剧本，零网络）：pi-events 事件矩阵 toEqual（P10 初值双方言、
    toolcall 三形态、终态恰一次、done reason 全集、usage 折算与全零守卫、error usage 先行、abort
    rethrow、防御层流耗尽/垃圾事件）；pi-context 矩阵（四角色、input 降级三态、toolName 回查、
    空 user 跳过、工具表、maxTokens 注入不对称）；classifyErrorText 词边界负例全表
    （"used 14290 tokens"≠429 等）；parseRetryAfterMs 全态（小数秒/HTTP-date/过去=0/不可解析）；
  - 真身冒烟层（`fetch`→scene-server 本地 HTTP，过 pi 真 HTTP/SSE 栈——默认门内唯一 wire 防守）：
    anthropic 全文流（初值+delta+usage 折算+finish；请求头 `x-api-key`/`accept-encoding: identity`/
    `anthropic-version`；请求体 `model`=request.model（回归：适配器名曾误入请求体）/`max_tokens`
    8192/system 块数组/无 cache_control）；429+retry-after 头 → `http-429`+retryAfterMs（fetch 包装
    捕获）；中途断连 → error 事件 → `network`；连接拒绝 → `network`；请求前 abort → throw；
    openai 全文流（usage 后置折算、仅显式 maxTokens、Bearer、identity 头）；
  - 既有回归：runtime（适配器同步 throw/异步 reject 归一、waterfall 改写流）；llm-retry 码表；
    agent-loop stream-frames（thinking 流帧）与假适配器 e2e 旅程（不经过 wire）。

## 6. 方案审查处置（§1.5 两路并行——A 协议事实面 / B 实现可行性面）

采纳（A）：孤立 tool_use 合成空结果（中断重放 400 砖化）；usage 快照随事件即发（根治与
message_stop 恰一次的自相矛盾——早断/失败尝试计费存活）；stop_reason 全集（refusal/sensitive→
error finish）；error 事件提取嵌套载荷且 overloaded_error→network（重试闭集覆盖）；temperature
透传；input 非对象降 {}；cache 桶并入 input（GLM 桥不低计）；空 user 跳过。
采纳（B）：底座抽 sse-scan/http-dial（硬化修复一份实现，openai 同提交改消费删内联）；合并块序
钉死（tool_result 前置、文本独立块、绝不折入 tool_result.content）；max_tokens 缺省 8192 +
maxTokensDefault 逃生位；测试假绿四项（usage 值来源/挂连接/finish 后 error/稀疏 index）；
e2e:real 协议 env 闭集与 provider 名一致性。
落档驳回：callId 跨 provider 归一化（换 provider 续用同一 session 的边缘场景，记已知限制）；
纯文本 error 帧的 event: 行分派（标准实现恒发 JSON 载荷，降级为 network 归类——已知语义）。

## 7. anthropic 批代码审查处置（两路并行——A 协议正确性 / B 测试假绿）

采纳：孤立配对改出现次数计数（answered 集合曾使重复 callId 第二次孤立漏合成）；无主
tool_result 丢弃；多字节撕裂用例改字节级切片（码点切片拆不开多字节字符——{stream:true} 回归
曾全绿）；读体中断用例改「分片产出后延迟断连」（destroy-before-write 走的是拨号 catch，流式
catch 是死码）；finish 内容钉死（count-only 可被「丢 stop 只发 error」骗过）；openai [DONE]
trailing 夹具恢复；非 JSON 帧补真向量；sensitive/未知 stop_reason、input 降级全向量、尾部孤立、
assistant text 块、createAnthropicCompatLlm 覆盖补齐；空 usage 快照不发噪音帧；无消费者导出
收回包内；PROTOCOL 非法值显式报错（静默降 openai 会拿 anthropic 凭据打错端点）；测试装置
句柄泄漏修复。驳回附理由：isTerminator 双 parse 合并（会让扫描器带协议状态，违反底座零知识注入）。

## 4. 验收清单

- [x] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告（见提交说明）

## 5. 代码审查处置（回炉批，4×P1+8×P3）

P1 EOF 半行帧丢失（终 flush 只认换行）→ drainFinalLine 整行处理 + 回归；P1 [DONE] 不停读 +
releaseLock 后 cancel 无效 → 停读标志 + 先 cancel 再释放 + 连接释放回归；P1 δ/2ⁿ 子序按 sort
惰性求值分配（前向引用错序）→ 注册序预热；P1 重试预算键缺 session（跨会话互烧）→ 键含 session +
sessionDisposed 回收。P3：message 三重前缀（只给体摘要）；HTTP-date 解析（过去=0）；abort 豁免
两段对称（finalSignal）；归一层双 finish 落档；下游异常 stderr 留痕；封存会话 fail-closed；
meter 冻结深度与溢出 O(1) 短路；adapter-plugin 覆盖。
