# 思考流式透传（thinking-delta）方案

> 状态：定稿
> 级别：中

## 契约

1. `LlmChunk`（llm/src/types.ts）新增变体：`{ readonly type: "thinking-delta"; readonly text: string }`。
2. anthropic 适配器映射：`content_block_delta` 的 `thinking_delta.thinking` → thinking-delta；
   `content_block_start` 的 `thinking` 块初值（`thinking` 字段非空）→ thinking-delta；
   空串/字段缺席/非字符串 → 不产 chunk 不崩（与 text 的 typeof 守卫同策）；
   `signature_delta` / `redacted_thinking` / 未知块与未知 delta → 跳过。
3. `AssistantStreamFrame`（agent-loop/src/tokens.ts）chunk 帧改为
   `{ phase: "chunk"; kind: "text" | "thinking"; text: string }`——零双轨：不带 kind 的旧形状删除，
   仓库内消费方（step.ts 产出位、e2e/real.ts、docs 帧表）同批改净。start/end 帧形状不变。
4. 事件时序不变：每 attempt 恰一次 start、恰一次 end；thinking/text 帧按到达序原样广播，driver 不重排
   （协议上思考块先于正文块，时序由上游决定）；tool-call-delta/usage/finish chunk 不产帧。
5. 落账（docs/STREAM-PARTIAL-PERSISTENCE.md 翻转原「不落账」）：thinking 不进
   `assistant/message` content、不进 `deriveMessages`、不回传请求；**全文落
   `assistant/message.thinking` / `assistant/attempt.thinking`**（本 attempt 增量拼接，
   缺席=无思考）。`StreamAccumulator` 收集 thinking-delta（不进 text/hasContent——空结算
   判定不含思考）。thinking-only + finish(stop)
   → empty completion 结算（无 code）→ `agentRequestError` → llm-retry 对无 code 恒不重试 → turn error
   终态（既有语义，非本件新增裁决）；thinking-only + finish(max-tokens) → 空 content 的 message
   max-tokens（既有语义）；thinking-only + abort → attempt("aborted") 走既有 fatal→aborted 映射。

## 问题域

- 处理：anthropic SSE thinking 增量 → thinking-delta chunk → agentAssistantStream 思考帧 → 终端实时上屏。
- 不处理：
  - openai 协议 `reasoning_content` 透传（openai-compat 不产出思考帧）（用户裁决：不用 openai 端点）；
  - 思考回放/回传（落账已由 docs/STREAM-PARTIAL-PERSISTENCE.md 实施；resume 回放渲染与
    回传模型仍另立项——session ContentBlock 与两适配器请求映射都要动）；
  - 请求侧 thinking 开关：`LlmRequest.thinking`（off/low/medium/high/max——max 为自适应模型无约束档，老预算型模型预算同 high）→ anthropic 侧注入
    `thinkingEnabled+effort+thinkingBudgetTokens`（docs/LLM-PI.md 契约 6）；缺省/off 不发参数。
  - `signature_delta`、`redacted_thinking`：按未知形状跳过。

## 并发/一致性预算

- 无新增并发面：复用既有同步 emit 路径（双层实测逐帧 ≤1ms）。
- 帧量级：思考 token 与正文同量级，每 token 一帧；广播即弃，累积器驻留思考全文至结算落盘
  （内存量级=正文同制，落盘不截断——STREAM-PARTIAL-PERSISTENCE 预算节）。

## 拆分

- llm 包：`types.ts`（chunk 变体）+ `pi-events.ts`（`thinking_delta` 事件 → thinking-delta chunk——
  wire 归 pi-ai，见 docs/LLM-PI.md）+ 注入层事件矩阵用例（思考交错/边界/全序）与 pi-wire 真身
  冒烟的思考透传断言。
- agent-loop 包：`tokens.ts`（帧形状）+ `step.ts`（emit 分支：thinking-delta → kind:"thinking"，
  text-delta → kind:"text"）+ `stream.ts`（累积器显式忽略 case）
  + `__test__/stream.test.ts`（忽略/empty/max-tokens 结算）
  + `__test__/driver.test.ts`（**帧断言装置**：makeWorld 的 ctx 上先于 followup 订阅
  `agentAssistantStream` 收集帧——事件即发即弃，订阅晚于 followup 会空数组空洞通过）。
- e2e：`real.ts` 思考帧上屏（TTY dim、非 TTY 原样；thinking→text 切换换行；
  `end{attempt}` 帧后换行分隔重试的思考段）。
- docs（与代码同批）：`LLM.md`（§1.1 chunk 词表 18-22 行、§1.5 映射行 129-133、§5 验收行 181）
  + `AGENT-LOOP-DRIVER.md` §1.2 帧形状表（41 行）+ 本文档。
- 依赖方向不变：agent-loop → llm（既有）。

## 实施顺序

1. llm 契约 + 适配器 + 单测（新变体先加出，尚无消费者，独立可回滚）；
2. agent-loop 帧形状 + 转发 + 累积器 + driver 级帧断言（消费方同批改净，零双轨收口）；
3. e2e real.ts + docs。
每阶段验收：本包单测全绿；收口验收：四门全绿 + 覆盖率 ≥ 既有阈值。

## 裁决

- 仅 anthropic 端点；openai 不实现思考透传（用户裁决：不要用 open.bigmodel.cn/api/paas/v4）。
- 思考瞬时广播 + 落盘不回传（docs/STREAM-PARTIAL-PERSISTENCE.md 翻转原「不落账」裁决，
  用户裁决 2026-09-21：截断已收内容必须落盘）：本 attempt 思考全文落
  `assistant/message.thinking` / `assistant/attempt.thinking`；`surfaceToMessages` 白名单
  投影不回传——请求体/压缩摘要输入不含思考。resume 回放渲染仍不在契约内（未来件）。
- chunk 帧加 `kind` 判别字段、删除旧形状（默认裁决：判别联合单轨，同仓库「同一事实一套接口」纪律）。
- 请求体恒不带 `thinking` 开关；「真端点确实到达思考块」这一前提由 opt-in 的 e2e real.ts 验证，
  是否运行由用户拍板（默认门内无法暴露此断层——mock 测试天然全绿）。

## 测试口径

- 契约断言：
  - anthropic-compat（表驱动）：`thinking_delta` → 逐帧 thinking-delta；start 初值非空 → thinking-delta；
    start 初值+delta 同块组合断言两帧独立且先初值后增量；`thinking_delta thinking:""`/字段缺席/非字符串
    → 不产 chunk 不崩；start thinking 块字段缺席/非字符串 → 不产 chunk 不崩；`signature_delta`/未知 → 不产；
    text→thinking→text 交错与双 thinking 块顺序（整帧数组 toEqual）；thinking 不混入 text-delta。
  - StreamAccumulator：push thinking-delta 后 `text`/`textBlock`/`toolUseBlocks`/`hasContent` 全不变
    （语义锁——switch 无穷尽断言，该用例不背书「case 已写」，分支覆盖由 driver 级用例承担），
    `thinkingText` 增量拼接（落盘面——STREAM-PARTIAL-PERSISTENCE）；
    thinking-only + finish(stop) → empty completion；thinking-only + finish(max-tokens) → message max-tokens。
  - driver 级（整帧数组 toEqual，锁形状+顺序+不重排）：
    - 脚本 thinking→text→thinking→text 交错 + 掺 tool-call-delta/usage → 帧序列恰为
      start→(仅 thinking/text chunk 帧)→end，非文本 chunk 零帧；
    - attempt 重试边界：errorScript 后接成功脚本 → 两个 start、一个 end{attempt}、一个 end{message}；
    - abort 变种（复用悬停流装置）：thinking-only + abort → attempt 终态；
      thinking+text 部分 + abort → interrupted message 且 content 只含 text；
    - 落盘不回传（哨兵串 THINK-SENTINEL，STREAM-PARTIAL-PERSISTENCE 翻转后口径）：
      thinking 脚本 + 工具续步后，assistant/message.thinking 含哨兵（交错增量拼接序），
      第二次请求体不含哨兵（投影白名单）。
- 分层：单元（两包 `__test__`）；e2e real.ts 为 opt-in 观察脚本，不进默认门。

## 验收清单

- [ ] 契约：chunk 变体 / 帧 kind / 时序 / 非文本 chunk 零帧 / 落盘不回传（thinking 落
      事件 thinking 字段；请求体与投影零泄漏）
- [ ] 边界：空初值、字段缺席、非字符串、交错、双 thinking 块、attempt 边界、abort 两变种、
      thinking-only stop/max-tokens 终态
- [ ] 预算：无新增并发面；思考全文驻留至结算（与正文同制）
- [ ] 四门全绿 + 覆盖率数字如实报告
- [ ] e2e real.ts 思考上屏（非 TTY 输出可区分 thinking/text；真凭证运行与否由用户裁决）
