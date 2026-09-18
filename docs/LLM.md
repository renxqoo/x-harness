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

### 1.5 anthropic-compat 适配器（`createAnthropicCompatAdapter({ name?, baseUrl, apiKey, fetch?, maxTokensDefault? })`；缺省名 "anthropic-compat"；插件 `createAnthropicCompatLlm` name "llm-anthropic-compat" inject ["llm"]）——用户裁决新增；方案审 A/B 两路处置见 §6

POST `{baseUrl}/v1/messages`，headers `x-api-key` + `anthropic-version: 2023-06-01`，`stream:true`。

**共享底座（本节新增的抽取，openai-compat 同提交改消费并删内联版——同一事实一份实现）**：
- `sse-scan.ts`：字节流 → data payload 序列（跨 read 行缓冲、TextDecoder stream、CRLF、注释/
  `event:`/`id:` 行跳过、EOF 整行终 flush、终止符回调 `isTerminator(payload)` 停读、
  先 `cancel` 再 `releaseLock`）；
- `http-dial.ts`：拨号段 + `Retry-After` 解析（小数秒/HTTP-date/过去=0——协议无关，禁止第二份）。

**请求转换（anthropic-request.ts）**：
- system → **顶层 `system` 字符串**（相邻拼接）；`temperature` 透传；
- user → `{role:"user", content}`；text 拼接为空串的 user 消息**整条跳过**（垃圾降级）；
- assistant → `{role:"assistant", content:[{type:"text"}…,{type:"tool_use",id,name,input}]}`；
  input = JSON.parse 结果，**parse 失败或非 plain object（null/数组/原始值）→ `{}`**；
- tool → user 消息 `{type:"tool_result", tool_use_id, content, is_error?}`；**相邻同角色合并**：
  拼接 content 数组，**tool_result 块全部在前**（callId 序对齐 assistant 的 tool_use 序）、user
  文本转独立 `{type:"text"}` 块在后——绝不折入 tool_result.content；
- **孤立 tool_use 合成空结果（出现次数配对）**：callId 按「出现次数 − 结果次数」配对——重复
  callId 的每次未答出现各合成一条 `{type:"tool_result", tool_use_id, content:"(no result
  provided)", is_error:true}`（中断/中止的历史重放不再 400 砖化）；**无主 tool_result**
  （无 tool_use 配对的乱序/垃圾卷）直接丢弃——带上会 400；
- `max_tokens` 必填：`request.maxTokens ?? maxTokensDefault ?? 8192`（协议硬约束；Agent 写大
  文件负载下 4096 易截断误判收轮）；工具表 → `{name, description?, input_schema}`。

**流事件（sse-scan 底座；data 帧按 JSON `type` 分派）**：
- `message_start` → 发 usage 快照 `{input: input_tokens + cache_read + cache_creation}`（cache
  桶并入 input 保 total 口径——GLM 桥自动缓存不低计）；**usage 是快照语义、随事件即发**（消费方
  last-wins 幂等）——早断/截断/失败尝试的 input 账不丢（token-meter 计费依赖）；
- `content_block_start`：`text` 带初值 → text-delta；`tool_use` → tool-call-delta `{index,
  callId:id, name}`（index = content block 索引**原值透传**——夹 text/thinking 块时稀疏，消费方
  按 index 聚积排序安全）；`thinking`/未知块类型 → 跳过（content_block_stop 恒 no-op）；
- `content_block_delta`：`text_delta` → text-delta；`input_json_delta` → tool-call-delta
  `{index, argumentsDelta:partial_json}`；`thinking_delta`/未知 → 跳过；
- `message_delta`：`stop_reason` → finish **恰一次**，映射全集：end_turn/tool_use/stop_sequence/
  pause_turn→stop；max_tokens→max-tokens；refusal/sensitive→`finish{error, message:
  stop_details.explanation ?? stop_reason}`；未知→stop（fail-open 落档）；`usage` 存在 →
  **字段级合并**进快照（input 保留自 message_start，代理只回 output 不归零——P8）后再发一帧；
- `message_stop` → 终止符（停读 + cancel）；
- `ping` → 跳过；`error` 事件（`{type:"error",error:{type,message}}`）→ 受 finish 恰一次守卫：
  未发过 → `finish{error}`（`overloaded_error` → `code:"network"` 进重试闭集；其余 type 落
  message）；已发过 → 忽略；
- EOF 未见 `message_stop`：finish 未发过 → `finish{error, code:"network"}`；已发过 → 不再发
  finish（usage 已随事件即发，不丢）；非 2xx/连接拒绝/读体中断/请求前 abort 同 §1.4 三段位。

**e2e:real（§3 同变）**：`X_HARNESS_E2E_REAL_PROTOCOL ∈ {openai, anthropic}`（缺省 openai；
缺席**不触发 skip**——skip 三变量口径不变）；provider 名与 adapter.name 精确一致
（anthropic 缺省 "anthropic-compat"）；BASE_URL 语义随协议（`/v1/messages` vs `/chat/completions`）。

## 2. 问题域

**处理**：适配器注册/解析（no-adapter 错误结算）；llm/stream waterfall；SSE 硬化解析与格式转换；
失败契约（code/retryAfterMs 结构化透出）。
**不处理**：重试策略本体（LLM-RETRY 件）；用量记账（TOKEN-METER 件）；计费。
（前版「不处理：非 OpenAI 兼容协议」作废——用户裁决：必须支持 Anthropic 协议，见 §1.5。）

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
- anthropic-compat（本地 HTTP 假服务器，表驱动事件脚本，分片写制造撕裂）：
  - 请求体（精确 JSON 断言）：system 顶层化；**相邻合并块序**——`[assistant(tool_use c1),
    tool(result c1), user("steer")] → 恰一条 user content=[{tool_result c1},{text "steer"}]` +
    N 并行 tool_result 合一向量；孤立 tool_use 合成 is_error 空结果；input 解析失败与非对象
    （"null"/"[1]"/"5"）降 {}；max_tokens 缺省 8192 与 maxTokensDefault 逃生位；temperature
    透传；input_schema 工具表；空 user 跳过；
  - 流：message_start（usage input 含 cache 桶并入）+content_block_start（text 初值不丢/
    tool_use 身份/`thinking` 块夹杂跳过且**稀疏 index 原值透传**——双 tool_use 夹 text 块
    index 1/2 非重编号 0/1）+text_delta/input_json_delta 分片+message_delta（stop_reason
    **全集**：end_turn/tool_use/stop_sequence/pause_turn/max_tokens/refusal/sensitive/未知；
    usage 字段级合并——只回 output 时 input 不归零）+message_stop 终止 + **挂连接释放断言**
    （afterDone 装置，socket close 计数）+finish 已发后 error 事件忽略（恰一 finish）+
    overloaded_error → code network+message_delta 后 EOF（无 message_stop）→ 恰一 finish(stop)
    且 usage 不丢+ping/trailing（P9）+EOF 无 finish → network；非 2xx/连接拒绝/abort 三段位。
- 契约：token 词表锁定；组装器（agent-loop StreamAccumulator）已由件5覆盖分片聚合幂等。

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
