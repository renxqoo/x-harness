# Agent-Loop 件方案（循环本体：收件箱投影 / turn-step 状态机 / 流结算 / 工具调度 / resume 修复）

> 状态：定稿（对抗审查 20 条已逐条处置，见 §5）
> 级别：大（核心件；上游纲领 docs/AGENT-LOOP.md §3 处置 P2/P4/P5/P6/P7/P11/P13/P14/P16 全部落实于此）
> 依赖拓扑：session（14 词条）+ tools（dispatch/concurrencyOf）+ llm（stream waterfall）+ system-prompt（assemble）。

## 1. 契约

### 1.1 类型与服务

```ts
export interface AgentOptions {
  readonly provider?: string; readonly model?: string;
  readonly temperature?: number; readonly maxTokens?: number;
  readonly systemPrompt?: string;              // 静态提示词，优先于 systemPrompt.assemble()
  readonly maxParallelToolCalls?: number;       // 默认 10
  readonly maxToolResultChars?: number;         // 默认 100_000：tool/result 落账前截断（尾标 …[truncated]）
  readonly streamIdleTimeoutMs?: number;        // 流空闲看门狗，默认 300_000（≤0 关闭），SDK 面（无 CLI flag——同 llm-retry 先例）
}
export interface Agent {
  readonly session: Session; readonly options: AgentOptions;
  readonly status: "idle" | "running";
  followup(text: string): void;                 // insert next-turn + 唤醒
  steer(text: string): void;                    // insert next-step + 唤醒
  inject(text: string): void;                   // insert next-step 不唤醒
  cancel(cause: string, options?: { keepInbox?: boolean }): void;  // 缺省 append clear 事件后 abort；置 per-kick sticky 取消（链式窗口防丢）；cause 空串护栏为 "cancelled"；claim 后到达不撤已领条目（写明）
  whenIdle(): Promise<void>;                    // 收敛循环（do/while 重查，跟替换驱动）
}
export interface AgentHandle { readonly agent: Agent; dispose(): Promise<void> }
export interface AgentLoopService {
  create(options?: { session?: CreateSessionOptions; agent?: AgentOptions }): Promise<Result<AgentHandle>>;
  resume(options: { id: SessionId; agent?: AgentOptions }): Promise<Result<AgentHandle>>;  // 无 sessionArchive → 失败
}
```

### 1.2 token（9 个，纲领 P13）

| token | 模式 | 载荷 | freeze |
| --- | --- | --- | --- |
| `agentStatus` | emit | `{ session, status }` | none |
| `agentError` | emit | `{ session, turn, message }`（turn 终态 error 的活观察） | none |
| `agentAssistantStream` | emit | `{ session, turn, step, frame }`：`{phase:"start"} \| {phase:"chunk", kind:"text"\|"thinking", text} \| {phase:"end", kind:"message"\|"attempt"}`（thinking 帧仅广播不落账——docs/THINKING-STREAM.md；end 以落账为前提） | none |
| `agentPreStep` | waterfall | `{ session, turn, step, messages, signal }`（messages 仅供观察——请求体恒 deriveMessages 不变量）→ `{kind:"enter"} \| {kind:"reject", reason}` | none |
| `agentRequest` | waterfall | `{ session, turn, step, dial, signal }`（dial=当前折叠拨号）→ 拨号 `{model, provider?, temperature?, maxTokens?, thinking?}`（thinking 词表 off/low/medium/high——llm 侧注入 anthropic thinking 参数） | none |
| `agentRequestError` | waterfall | `{ session, turn, step, failure, signal }` → `{kind:"retry"} \| undefined`（缺省终态） | none |
| `agentTurnStopping` | serial | `{ session, turn, signal }`——窗口后重读收件箱定续航（数据驱动） | none |
| `agentAssistantSettle` | waterfall | `{ session, turn, step, content, stopReason, interrupted? }` → 同形（落账前纠：改写版即落账版） | none |
| `agentLlmStream` | waterfall | `{ request }` → `AsyncIterable<LlmChunk>`（agent 层流包裹，final = llm.stream；全局回放/路由类拦截用 llm 包 llm/stream root 层） | none |

### 1.2.1 流空闲看门狗（step.ts consume）

- `streamIdleTimeoutMs`（AgentOptions，默认 300_000，≤0 关闭；SDK 面——不进 Dial 闭集、不落
  request/header、resume 后回落缺省；delegation 子代理经 childAgentOptions/revivedOptions 透传
  父显式值）。相邻 LlmChunk 间隔超时 → attempt 级 AbortController 止损（换绑 dispatchLlmStream
  的 signal 使 abort 打到底层 fetch；turn 级 signal 只联动取消——**看门狗不触碰 turn 信号，
  取消语义独占**）→ 注入 `finish{kind:"error", message:"stream idle timeout", code:"network"}`
  （走 finish 分支携带 code——throw 路径无 code 会导致 llm-retry 不重试）→ attempt 落账 →
  llm-retry 重拨；预算尽/未装重试件 → turn error（有界失败，静默挂死不可再发生）。超时后
  pending 的迭代推进附挂 catch 收殓 + `iterator.return()` 尽力收殓（不留悬空协程/rejection）。
- 三个看门狗语义边界：本件 streamIdleTimeoutMs（超时→network 可重试）；compaction idleTimeoutMs
  （摘要流，超时→aborted 跳过本轮不可重试）；autocompact checkpointIdleTimeoutMs（join 超时）。
  本件缺省 300s（prefill 长停顿余量），另两者 120s——数值各自独立。
- 误伤面：大 prompt prefill 期零帧可能超过缺省 120s（推理模型深思期通常持续吐 thinking 帧）；
  误伤后果 = 丢本 attempt 已收文本 + 重拨烧预算——fail-loud 优于挂死，可调大或 ≤0 关闭。

### 1.3 收件箱投影（inbox.ts）

`foldInbox(events) → { nextTurn, nextStep }`：insert 追加目标队列（**判重按当前在场**——claim 移除后同 id 再 insert 重新入队，repair 回灌依赖）；claim 按 `claimed` id 全集从双队列移除；clear 双清。entry id 由 loop 铸 `crypto.randomUUID()`。step0 领取 = 一条 claim{next-turn}（claimed = next-turn 队首 + next-step 全部 ids）；后续步 claim{next-step}。

### 1.4 turn/step 状态机（driver.ts）

```
kick(): while (await turn()) {}；exit 先判锁存唤醒 replay（收件箱确有 next-turn 才重放——防空 turn）再发 idle——
  replay 边界不发假 idle（同步监听者不得在「即将继续」的边界上做生命周期决策）
  sticky 取消以 kick 边界为界：cancel 后再 followup/steer 可开新 kick（dispose 后的抑制由 session 封存承担）
  idle 通告收敛：notifyIdle 前复查 phase——idle 监听器重入 followup 时不提前 resolve（由新 kick 的 finally 收尾）
turn()（逃逸 throw——中间件违约/append 失败——在 turn 内 catch：turnEnds={error} 后由 finally 单次收轮）:
  append turn/start {turn}
  循环 {
    步起点查 signal.aborted → 直达 turnEnds={aborted}（工具结果已落齐的收尾）
    preStep: fold 收件箱 → 无领取不落 claim 不落 user/message（防空 claim 尾随触发回灌噪音）
      → claim（落 claim 事件，claimed = 领取 ids）→ waterfall agentPreStep：
      reject → 回灌已领批次（insert 原对象：同 id、保原 target，next-turn 与 next-step 各一事件——repair 的
        trailing-claim 按旧 id 回灌依赖同 id 在场判重）→ turnEnds={blocked, reason?}（reject 载荷
        reason 透传——空串省略，与 aborted.cause 同口径）跳出
      step0 且领取空 → turnEnds={completed}（不花模型调用）跳出
    append step/start
    system/message 锚点策略：turn 1 step0 恒落锚点（文本可空——门 isStr 不查非空），
      使「有 system 节点→replace[seq,seq]」恒可达；后续步文本同现值→跳过（空文本投影 dormant——session 投影侧跳过空 system 节点）
    user/message（领取批次 content 块，surface append）
    拨号（request.ts）：逐字段折叠（options 显式值恒胜；否则末次 request/header 同名字段；中间件改写落 header 后成为后续折叠基底=有意粘性）→
      waterfall agentRequest（输入携当前折叠拨号；输出过同形四字段形状门——违约垃圾按 bad-dial error 收轮）→
      model 缺失 → turnEnds={error, message:"no model configured", code:"no-model"}；均先闭 step/end 再跳出（括号形状一致）；
      tools 每步从 toolRegistry.schemas({ sessionId })（W2A 分层投影） 现取（LlmRequest 全量；request/header 落 ToolRef 投影=剥 inputSchema）；
      append request/header（与末次规范化深比较不同才落，比较含 tools）+ request/context（provider 与 model 齐备且变化才落）
    流结算（stream.ts）：请求体 = session.deriveMessages()（纯折叠不变量）→ llmRuntime.stream：
      finish stop → append assistant/message{content,usage?,stopReason:"stop"}（surface append）
      finish max-tokens → 同上 stopReason:"max-tokens"；turnEnds 粘性 max-tokens
      finish error / 流抛 / 流无 finish（P14 兜底）/ finish stop 但零文本零工具（空结算，视同流错误）→ append assistant/attempt{error=`code:message`} → waterfall agentRequestError
        {retry} → 重进 attempt（不重落 system/user/header）；否则 fatal：源于 abort（signal 已断）按 {aborted} 收尾，
        其余 turnEnds={error}；均先闭 step/end 再跳出
      中途 abort 且已有部分文本 → append assistant/message{…, interrupted:true}；无文本 → attempt（终态仍 aborted）
    assistant 的 tool_use 块 → tool-calls.ts 调度（§1.5）；additionalContexts → insert next-step；concludesTurn → {completed}
    工具相位结束查 signal.aborted → 直达 turnEnds={aborted}
    stopReason 判定：stop 且无工具→{completed}；有工具且未 conclude→null（下一步）；max-tokens→粘性
    concludesTurn × additionalContexts（P16 优先级）：contexts 非空时 conclude 延后——本步继续（上下文需模型消化），
      下一步若又跑工具则 pendingConclude 复位（工具结果也是待消化上下文，不半途强制收轮），
      无工具步结束且无新 contexts 时收轮（pendingConclude 标志）
    append step/end
    stopping 续航窗口（仅 completed 可续航）：next-step 已有内容（流中 steer——stop 无工具场景）直接续航；
      否则 dispatch serial agentTurnStopping → 重读收件箱：非空 → turnEnds 复位继续
    turnEnds 覆盖全序格：aborted > error > max-tokens > completed（aborted 即替换；completed 不升级覆盖已有 max-tokens）
    append 失败统一策略：致命 → 尽力落 turn/end{error}，落不上也退 idle 并 emit agentError
    turn() 顶层 catch（中间件违约等逃逸 throw）→ turn/end{error} → 发 idle
  }
  finally append turn/end {turn, reason}（aborted 带 cause、blocked 带 reason——词表已扩）
  链式条件：未置 sticky 取消 ∧ 终态 completed ∧ 有 next-turn——异常终态（error/max-tokens/
    aborted/blocked）一律不链：排队消息原地保留（下次 kick 的 step0 消费），立即 idle 让
    完成通知出（SUBAGENT-FAILURE-NOTIFICATION）。锁存唤醒 replay 不在此列：飞行中新
    followup 到达是用户主动唤醒语义（idle 可唤醒契约的另一半），照常 replay（replay 判定
    先于 idle 发布——replay 边界不发假 idle）
    → 链式新 turn：新 AbortController 在 turn/start 落账前完成交换
```

### 1.5 工具调度（tool-calls.ts）

落账走 mustAppend（Result 检查，失败即 throw 逃逸由 driver 收 error turn/end）——tool/call↔tool/result 配对不变量不容静默丢失。

- args 解析：raw === "" → `{}`；`JSON.parse` 失败 → **原文保留**（字符串进 dispatch，违规回显自纠）。
- 分组：`registry.concurrencyOf(name, args)` 逐 call 分类——排他（缺省/未知/抛错）单独成屏障；连续 parallel 进池（上限 `maxParallelToolCalls`，超限顺延下一池）。
- 时序：本组全部 `tool/call` 按 model 序先落账 → dispatch 并发执行 → `tool/result` 按 model 序落账（content 经 `maxToolResultChars` 截断）。
- abort：停止补充启动；已启动的取其 outcome（registry 归一化 aborted）；未启动的合成 `tool/result {isError, content:"tool call aborted before dispatch"}`。

### 1.6 resume 修复（repair.ts）

`interruptedTurnClosers(events)`：仅追加不改写，时间戳复用末事件——
1. 未配对的 tool_use（以 **assistant/message 块** 为键，纲领 P5）：无匹配 `tool/result`（按 callId）→ 合成错误结果；有对应 `tool/call` 事件 → 文案 "outcome unknown: verify external state before retrying"；无 → "not started: retry if still needed"。
2. 未闭合 `step/end` → 补；未闭合 `turn/end` → 补 `{kind:"interrupted"}`。
3. **claim 回灌**（P2）：后缀语义（末次 user/message 之后的 claim 连续段）判定未被消费的 claim → 回灌其 claimed entries（last-insert-wins：取 claim 之前最后一次同 id insert 的内容；多 turn 多 claim 历史无误报——活跃运行的 claim 恒紧邻同 turn user/message）。
4. **信封铸造**：合成 tool/result 带 `surfaceOp:"append"`；step/end、turn/end、回灌 insert 不带；seq 连续铸造；未闭合号取末个未配对 turn/start / step/start。
resume 后**不自动 kick**（回灌条目等宿主显式 followup/steer 唤醒）。
resume = `sessionArchive.read` → closers → `store.create({ header, seed: [...卷, ...closers] })`。

### 1.7 并发/生命周期（纲领 P4）

单飞行 turn（相位机）；followup/steer/inject 仅落 insert 事件 + 唤醒（运行中锁存，idle 重放，disposed 抑制）；`cancel` 缺省 append `clear` 事件再 abort（keepInbox 跳过 clear）；`whenIdle` do/while 收敛；`dispose` = cancel("disposed") → whenIdle → scope.dispose。每 agent 一个 `ctx.scope({ agentId })`（token 词表共享、监听可按层挂）。

## 2. 不处理

| 项 | 归属 |
| --- | --- |
| 检查点策略（何时 flush） | 件 6 session-checkpoint |
| 压缩/滑窗策略 | 后续策略插件（replace 原语已备） |
| 重试策略本体 | 后续插件挂 agentRequestError |
| delegation/subagent、agent registry | delegation 里程碑 |
| turn/step 结构不变量伴随插件 | 后续（DSH invariant 思想，repair 已含最小闭合语义） |

## 3. 测试口径

- 契约：token 词表（7 个）锁定；create/resume 服务签名。
- 状态机事件序列断言（脚本化假 LLM 适配器 + 假工具）：fresh turn（无工具）/多步工具 turn（tool_use→tool/result→下一步）/steer 续航（turn-stopping 后重读）/steer 流中注入不搁浅（stop 无工具后重读续航消化——回归）/abort 中途（interrupted 消息/attempt + aborted cause）/max-tokens 粘性/request-error retry（中间件返 retry）/no-model 失败/unknown tool（isError 结果继续多步）/排他与并行池分组与 model 序提交/abort 未启动合成结果。
- 收件箱：fold 表驱动（insert/claim 双向/clear/在场判重/回灌重入队）；followup 并发多次 → 链式多 turn。
- repair：各残卷形态（悬空 tool_use 两态/缺 step/end/缺 turn/end/claim 回灌/balanced 零修复）。
- 截断：超长 tool result 截断 + 标记。
- 回归（对抗审查处置，逐条注明症状）：cancel 后再 followup 复活（sticky 取消以 kick 边界为界）；
  abort 无部分文本 → attempt + aborted cause（不误标 error）；中间件逃逸 throw → turn/end 单次 error 收尾；
  agentRequest 返垃圾 → bad-dial；concludesTurn 带 contexts 且模型续调工具 → 延后消化不半途收轮；
  idle 通告监听器重入 followup → whenIdle 收敛；step≥1 空领取 reject → 无空 insert 噪音；
  preStep reject 回灌同 id 保原 target；retry 不重落 system/user/header；max-tokens 带 tool_use 粘性；
  steer 流中注入不搁浅；池后跟排他/maxParallel=1 串行边界。

## 5. 审查处置记录（20 条）

F1 词表 aborted 扩可选 cause（session 门同步）；F2 链式条件=仅 completed（异常终态一律不链——blocked 防活锁语义并入，SUBAGENT-FAILURE-NOTIFICATION 扩至全异常态；锁存唤醒 replay 先于 idle 发布、replay 边界不发假 idle）；F3 system 锚点策略（恒落锚点+空文本 dormant 投影，纲领 P11 同步修正）；F4 步起点与工具相位后直查 abort；F5 per-kick sticky 取消+controller 先换后落账；F6 preStep enter 输出无 messages（观察专用）；F7 续航仅 completed、继续时复位；F8 覆盖全序格；F9 tools 现取+ToolRef 投影+context 齐备才落；F10 逐字段折叠+options 恒胜+改写粘性写明；F11 空结算视同流错误；F12 append 失败统一致命策略；F13 turn 顶层 catch；F14 回灌保原 target 单事件批量；F15 closers 信封铸造细则；F16 回灌后缀语义+last-insert-wins；F17 conclude 延后至 contexts 消化（pendingConclude）；F18 空 claim 不落；F19 resume 不自动 kick；F20 error 形状映射+cancel 空串护栏。

## 6. 代码对抗审查处置（实现后独立审查）

C1 wake/kick 边界：sticky 取消改为 kick 头复位——cancel 后 agent 可复活（曾永久砖化）；
C2 idle 通告收敛：notifyIdle 复查 phase，监听器重入 followup 不提前 resolve；
C3 逃逸 throw 单次收轮：catch 移入 turn()（曾 finally 先落 completed、kick 再落 error 双闭合）；
C4 agentRequest 输出形状门：违约垃圾按 bad-dial error 收轮（不进 header/流）；
C5 流 fatal 源于 abort 按 aborted 收尾（曾误标 error + 误发 agentError）；
C6 回灌同 id 原 target：复用原 InboxEntry 分 target 落 insert（曾铸新 id → resume 后条目重复）；
C7 pendingConclude 消化复位：续跑工具步不半途强制收轮（模型必须消化自己的工具结果）；
C8 abort 监听器赛后拆净（runAttempt 每次尝试不再累积 once-listener）；
C9 错误路径（no-model/bad-dial/fatal）也闭 step/end：括号形状一致；
C10 tool-calls 落账 Result 检查（mustAppend）：配对不变量不容静默丢失；
C11 repair 回灌按原 claim target 分组（保原 id）；
C12 spawn 失败补 store.dispose（不留可写会话）；plugin token 定义上移；
C13 followup/steer/inject 非字符串输入降级为 no-op。

## 4. 验收清单

- [ ] §1.1–§1.7 逐条；§3 序列断言逐条
- [ ] 四门全绿 + 覆盖率数字如实报告
- [ ] 方案审 + 代码审清零
