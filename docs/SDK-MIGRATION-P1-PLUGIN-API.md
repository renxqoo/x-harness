# P1 迁移文档：@x-harness/plugin-api——纯函数 archetype 层

> 状态：草稿。「比 dsh 更优」的落点：插件原语从 waterfall listener 升到**纯函数**——next 纪律/洋葱序/payload 形状由框架结构性保证，作者只写业务判断。
> 形态：上层包（packages/plugin-api），**零新语义**——全部 helper 是既有 token 的语法糖（最少面原则：本包不定义任何新拦截面）。

## 1. 行为规格基线

- 每个 helper 返回 Disposer；内部构建的 middleware 满足既有洋葱契约（含 tools 的 I2「调 next 后返回 deny」纪律——helper 封装之，作者不可写错）。
- 不注册任何新 token；不改任何 payload。
- 既有 1730 测试 + e2e 零改写（纯加法）。

## 2. Archetype 矩阵（四类 × 三域 + 逃生舱）

```ts
// —— 上下文域 ——
transformMessages(ctx, fn: (claim: readonly InboxEntry[]) => InboxEntry[] | Promise<...>): Disposer;
  // F0① 语法糖：pre-step 改写（claim 输入→messages 输出；注入纠偏=前插——inject 不单设，最少面）
transformAssistant(ctx, fn: (s: AssistantSettlement) => AssistantSettlement): Disposer;   // F0②
vetoStep(ctx, fn: (claim: readonly InboxEntry[]) => string | undefined): Disposer;         // pre-step 否决（载荷 claim 字段——收口审查 1.1）
// —— 工具域 ——
vetoTools(ctx, fn: (call: { callId; name; args; session? }) => { kind: "deny"; reason: string } | undefined): Disposer; // tools/pre-execute 载荷形状（收口审查 4.2①②）
transformToolResult(ctx, fn: (outcome: ToolOutcome, req) => ToolOutcome): Disposer;        // tools/execute 后处理
// —— 循环域 ——
transformDial(ctx, fn: (dial: Dial) => Dial): Disposer;                                    // agent/request
wrapStream(ctx, fn: (stream: AsyncIterable<LlmChunk>, req: LlmRequest) => AsyncIterable<LlmChunk>): Disposer; // llm/stream
// —— 观察类（tap：只读副作用，无返回）——
tapAssistant / tapToolCalls / tapStream / tapTurnEnd(ctx, fn): Disposer;
// —— 逃生舱 ——
tapSessionEvents(ctx, fn: (e: SessionEvent) => void): Disposer;                            // session/event 过滤（freeze:none 高频面——默认先用领域面）
```

## 3. 裁决

- **inject 不单设**：注入=transformMessages 的加法形态（最少面原则第一次执行）。
- **veto 的 next 纪律**：helper 内「先 next 后 deny」（tools I2 契约）——形态差异在作者文档言明。
- **transformToolResult 注册序（终审 P1-1 勘误：先注册=最外层）**：缺省（append）=内层（见原始 outcome）；`{prepend: true}` =外层（见他人后处理后）。
- 包装/装饰他人服务（微调四式之一）不做 helper——`use + provide` 三行即达，包成 sugar 反遮语义。

## 4. 测试：每 helper 一用例（变换落账一致/否决配对 deny/流包裹不改落账——与 F0 专测互补：F0 测面，P1 测糖）；零新 token 断言（词表不变）。

## 5. 回滚：纯加法单波 revert。

## 6. 验收：四门 + 用例绿 + 对抗审查（sugar 与裸 token 行为等价性逐 helper 核对）。

## 7. 实施记录（2026-09-20）

- **交付物**：packages/plugin-api——transform×4（Messages/Assistant/ToolResult/Dial）+ veto×2（Step/Tools）+ wrapStream + tap×4（Assistant/ToolCalls/Stream/TurnEnd）+ tapSessionEvents 逃生舱。全部为既有 token 语法糖（零新 token——词表不变断言由类型层保证：无 defineXxx 调用）；veto 一律先 next 后否决（I2）；transformAssistant 输出契约收窄 content/stopReason（interrupted 内核独占——糖层再保险）；transformToolResult 支持 prepend 注册序（收口审查 4.3）；tapSessionEvents 注释含三红线。
- **门禁数字**：typecheck ✓ lint ✓ test **148 文件/1754 用例**（+P1 等价性 6：改写落账一致/否决/纠/deny 配对+输出变换/流包裹+双 tap/拨号变换）e2e 全旅程 ✓ 内核门禁 ✓。
- **等价性锚**：糖与裸中间件行为逐 helper 对照（F0 专测测面、P1 测糖——互补）。
