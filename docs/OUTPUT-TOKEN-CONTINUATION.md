# 输出 token 上限截断续写方案

> 状态：草稿（文档轮 2 并行 + 增量轮 1 + 内核零策略收紧轮 + 载体重构轮 + 子系统化轮，问题全部处置）
> 类型契约单一真相：**docs/AGENT-MESSAGE.md**（内部消息子系统规范——本功能是其首个交付方；本文只引用不复制）
> 级别：中（跨 llm/session/agent-loop/compaction 四包 + 新插件包 agent-continuation；新增表面类型 agent/message、失败码词表项、agentTurnConclude 通用收束窗口钩子；改写 turn 终态语义——不改外部 API 形状，改既有 `max-tokens` 终态的内部行为）

## 需求（用户裁决，原文语义 + 两轮用户修订）

模型响应因输出 token 上限截断（`finishReason=length` / 原生 `max_tokens`、`max_output_tokens`、`model_context_window_exceeded`）且**无 tool call** 时，不立即收轮：保存半截回答 → 注入续写指令 → 先过压缩检查 → 续写；最多续写 3 次，第 4 次截断放弃并以可恢复错误收轮。续写期间暂停吸收排队用户输入；续写请求报上下文超限错误时响应式压缩后重试同一续写（不占额度不重置计数）；计数随 stop settle 归零、turn 收尾归零。

**用户修订①**：续写指令不再是「只进恰一条请求的瞬态尾部」，改为**持久类型化消息**（`agent/message`，UI 不展示）——详见裁决。
**用户修订②**：内部消息做成**通用可扩展基元**（「后面可能还有类似的消息，不用在 UI 展示」）——来源开放、语义类封闭的开闭契约。
**用户修订③**：delegation（子代理报告）迁移并入本功能第四批——报告从 user/message 载体迁到 agent/message{kind:"content"}，UI 不再当用户发言展示（用户裁决，推翻「挂账另立需求」的默认裁决）。

## 契约

**判定（单一真相在 llm 层归一，agent-loop 只看归一结果）**

- `LlmFinish` 变形：`{ kind: "max-tokens"; rawReason?: string }`——`rawReason` = provider 原生 stop reason（pi `AssistantMessage.rawStopReason`），诊断与词表判定共用。
- pi-events 映射（done 路径）：`reason === "length"` → `{ kind: "max-tokens", rawReason: message.rawStopReason }`。
- pi-events errorChunks 判定序（从上到下短路）：
  1. abort → `AbortError` throw（既有）；
  2. usage 折算先行（既有）；
  3. **救回**：`error.rawStopReason ∈ { "max_tokens", "max_output_tokens", "model_context_window_exceeded" }` **且流内已有内容** → 终态改发 `{ kind: "max-tokens", rawReason }`，不发 error finish。依据：pi `openai-completions mapStopReason` 对非标 finish_reason 全落 default→error（`max_tokens` 即中招）；与 refusal/sensitive/content_filter 同点归一是既有先例。内容前置的理由：零内容的救回两害——落空 `assistant/message` 且下一请求在 pi-context 被丢弃成「双 user 相邻 + 指令对着不存在的中断」；零内容时落到第 4 步 overflow 分类，`model_context_window_exceeded` 文本（"Provider finish_reason: …"）天然命中 OVERFLOW_PATTERNS → 走响应式压缩而非续写；
  4. **overflow 文本分类**：`isContextOverflow(event.error)`（pi 导出，文本模式；不带 contextWindow 参数）→ `{ kind: "error", code: "context-overflow" }`。优先于状态码——pi 把一切非 2xx 折成 error 事件且 errorMessage 携带 body，OpenAI/Gemini/Bedrock 的输入溢出主力形态是 HTTP 400 + overflow 文案，若排在 status 之后会落 `http-400`（既不可重试也不自愈），本功能标题承诺静默失效。代价：Anthropic 413 `request_too_large` 等带 overflow 文案的 413 从 `http-413` 改判 `context-overflow`——compaction 自愈触发两码皆收（见下），行为等价，llm 层审计码与既有用例预期同步更新（context-overflow 不可重试，`llm/retry` 事件不会携带它）；
  5. refusal/sensitive/content_filter 不可重试（既有）；
  6. `failureInfo().status` 在场 → `http-<status>`（既有）；
  7. `classifyErrorText` 兜底（既有）。
- 失败码词表扩展：`context-overflow`（不可重试——llm-retry 词表不含，由 compaction 自愈消费）。词表注释同步：`http-<status>` / `network` / `no-adapter` / `context-overflow`。
- rawReason 管道：`LlmFinish.rawReason` → `settleStream` Settlement message 变体 → `AssistantSettled.rawReason?` → driver 收束窗口载荷（插件可见）。

**agent/message 内部消息类型（引用 docs/AGENT-MESSAGE.md——子系统规范，本文不复制契约）**

- 类型/词表/消费方矩阵/扩展程序/存量迁移地图：全部以 AGENT-MESSAGE.md 为单一真相（session 单一真相模块 agent-message.ts：构造器 + kind 闭集 + 消费谓词）。
- 本功能在子系统中的角色：**首个交付方**——交付类型本体（session 三文件 + agent-message.ts 模块）+ 第一个 directive 消费者（续写指令 `{source:"output-continuation", kind:"directive"}`，source 常量住 agent-continuation 包）+ serialize 分流消费面。
- 后续消费者接入走 AGENT-MESSAGE.md §4 场景 A（新 source 零登记）；delegation 迁移 = §5 地图第二行（本功能第四批）。

**agentTurnConclude waterfall 钩子（内核机制，agent-loop tokens.ts 新词条——通用收束窗口，内核不识「截断」）**

- 词条样板 = `agentRequestError`（defineWaterfall 双类型参数 + 输出 union|undefined）——**不是** agentTurnStopping（defineSerial 串行事件；dispatch 无 final，照抄则无插件时每次派发即 throw）。与 agentTurnStopping 对偶：那个是 completed 收尾前的 inbox 注入窗口，这个是 settle 收束点的续跑决策窗口。
- **派发点 = 通用时点（循环结构事实，非功能判定）**：scheduleTools 得 flow none（无工具执行）之后、settleConclude 之前；interrupted/aborted/error/blocked 终态不经过此点（内核终态语义）。「tool_use 在场不续写」由此成为**结构保证**：带工具的 settle 执行工具、进下一步，收束点不可达。判定（何种 stopReason/rawReason 可续）完全归插件——钩子名与派发点不含截断语义，未来非截断策略（如完成度检查清单再跑一轮）可直接复用本窗口。
- 载荷（纯事实，无判断、无计数）：`{ session, turn, step, stopReason, content, rawReason?, signal }`。
- 返回形状门在 driver，两分处置：
  - `undefined`（中间件全让位）→ 现行收束路径原样（stop→completed；max-tokens→粘性收轮）——「无插件行为逐字节等于现状」只需此支成立；
  - 非 undefined 但形状不符（含 `resume` 而 instruction 非非空串、`fail` 而 message/code 非非空串）→ **fail-loud：error 收轮**（同 isDialShape/bad-dial 惯例——垃圾静默降级令插件 bug 无痕）。
  - 合法形状：`{ kind: "resume"; instruction: string（非空） }`；`{ kind: "fail"; message: string（非空）; code: string（非空） }`。
- 中间件契约（PLUGIN-AUTHORING 同步）：必须调 next 至少一次（内核违约 throw 逃逸收轮）；策略表达不得用 throw（放弃用 fail 应答）；让位 = 透传 `await next(payload)` 的下游结果。
- abort 竞态：派发期间取消 → 无决策按旧路径走，aborted 在全序格盖过粘性 max-tokens（既有 mergeOutcome 语义）。

**内核机制（driver/step，策略无关、截断无关）**

- resume 决策应用：append `agent/message{source:"output-continuation", kind:"directive", content:[{type:"text",text:instruction}]}`（表面事件，投影自动携带——**请求体纯折叠不变量原封不动，无尾部拼接机制**）；置 turn 级 `nextStepIsContinuation = true`（唯一新内核状态，一个布尔）；append `step/end` + `openStep = -1` 后 `continue` 外层步循环（跳过 settleConclude）。**出口不变量：`turnEnds === undefined`**——不得执行/保留现行粘性赋值（OUTCOME_RANK 下 completed 永远压不过已置的 max-tokens，粘性残留会把续写成功的轮误收为 max-tokens 终态：chainsNextTurn 断链、delegation notify 误报失败）。
- fail 决策应用：append `step/end`（同 dialFailure/fatal 分支形状）后置 `turnEnds = fatalOutcome(controller, cancelled, { kind:"error", message, code })`——复用 abort 覆盖（cancel 竞态按 aborted 收轮，与 fatal 同口径）——break。fail 的持久化记录 = `turn/end{reason:error, message, code}`（不另造审计事件）。
- 两分支共同前置：本次 settle 的 partial 已由 runAttempt 先行落账（保存先于判定）。
- 无决策（undefined）：现行路径原样——粘性 max-tokens 照现行语义置（带工具 settle 在工具分支置、无工具 settle 在收束点后置），stop 无工具 → settleConclude → completed → stopping 窗口。带 tool_use 的 settle 不经收束点（结构保证）。
- 续写步形态（`nextStepIsContinuation` 在场的下一个 step，消费后复位）：新相位函数（不复用 beginStep）——不领收件箱、不落 `user/message` 批次（**保序关键**：续写请求的末条消息必须是指令，排队 steer 不得插进指令与截断点之间）、reject 时跳过回灌（无可回灌，防「未领却重放 insert」审计噪音）、rewrite 输出忽略（无可改写批次；AGENT-LOOP-DRIVER §1.2 同步注明）；照常 `anchorSystem`（幂等）、`dialStep`（header 不变零落账）、`agentPreStep` 派发（claim: `[]`——压缩检查面保持）。**返回闭集 `{enter} | {blocked}`，empty 不可达**——driver 侧续写步不得套用 `empty → completed` 早退（现行 empty 仅 step0 可达是 beginStep 实现巧合，非契约）；step 号照常递增。
- 内核**不计数**：计数与复位规则（3 次上限、stop 复位、turn 归零）是策略，归插件（WAL 折叠，见策略插件节）。

**策略插件（新包 packages/agent-continuation）**

- `createContinuationPlugin(options?: { maxOutputContinuations?: number })`（非负整数缺省 3，0=首次截断即放弃——缺省住配置层）；inject `["session"]`（WAL 折叠读事件）。
- 处理器为 waterfall 中间件形态（必须调 next，让位 = 透传下游；llm-retry 同款纪律）：
  `async (payload, next) => { const downstream = await next(payload); return decide(payload) ?? downstream; }`
- `decide`（全部判定与策略住本包，内核零参与）：
  - signal 已断 → `undefined`（让位）；
  - 截断判定：`stopReason !== "max-tokens"` → `undefined`（正常完成走旧路径；载荷带 rawReason，未来策略可自扩词表不被锁死）；
  - 计数判定：折叠 session 事件得 `count` = 本 turn 内最近一次 `assistant/message{stopReason:"stop"}` 之后的 `agent/message{source:"output-continuation"}` 数（foldInbox/occupancy 同款纯折叠模式，resume 安全）；`count < maxOutputContinuations` → `{ kind:"resume", instruction: OUTPUT_CONTINUATION_INSTRUCTION }`；
  - 否则 → `{ kind:"fail", message: "The model's response exceeded the output token maximum.", code: "output-token-limit" }`。
- 指令常量与 source 常量（`OUTPUT_CONTINUATION_SOURCE = "output-continuation"`，计数折叠与内核 append 共用同一常量——单一真相住本包，经内核 resume 应用的 instruction 路径由内核以 source 落账）：
  `Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`
- harness 出 `continuationKit(options?)`；host-hub（worker/assembly.ts defaultPlugins）与 cli（build-world）装配面各 +1 行。不落可变 per-session 状态（计数每次从 WAL 现折）、不以 throw 表达策略。

**compaction 两处（插件内）**

- 自愈触发改闭集词表：`WINDOW_OVERFLOW_CODES = { "http-413", "context-overflow" }`（自愈机制零改动）。自愈语义（既有）：emergency 压缩先行重写投影 → `{kind:"retry"}` → 驱动重进 attempt 现场重读 `deriveMessages()`——重试发的是压缩后的新投影，非重放报错请求；重试仍溢出 → lastHealed 放行 fatal（无重试风暴）。续写场景下指令经投影天然保留（重试同一续写）；不占额度不重置计数——自愈重试不落 agent/message，插件折叠计数不变，天然正交。
- serialize 增 `agent/message` 分流：directive 跳过 / content 内容行（见类型契约节）；cut 零改动（类型非 user/message）。

**事件时序（续写成功路径，一次性事件恰一次）**

```
… assistant/message{stopReason:"max-tokens"} → [收束窗口：无工具 settle] → agent/message{directive=指令} → step/end
→ step/start → （无 user/message 批次）→ request/header 不变零落账 → [llm 请求 = 投影（指令已在内，末条）]
→ assistant/message{stopReason:"stop"} → step/end → turn/end{completed}
```

## 问题域

- 处理：截断信号归一（done 透传 + error 救回 + overflow 码 + rawReason 管道）、agent/message 通用内部消息类型（基元）、agentTurnConclude 通用收束窗口（内核机制）、策略插件（判定/计数/指令/放弃错误）、compaction serialize 分流 + 自愈触发词表、装配接线、文档同步、e2e 旅程。
- 不处理（归属）：
  - **第四批以外的 delegation 面**（子代理失败通知通道、task_output 复查面）——第四批只迁报告投递载体；其余 delegation 行为不动。
  - **agent/message 宿主写入 API 的最终形态**——inject 通道改型 or delegation 直写，第四批小方案探查投递时序后钉死（见实施顺序第四批前置）。
  - **`max-tokens + tool_use` 的粘性收轮**（工具结果滞留，由下次 kick step0 消化）——存量语义（AGENT-LOOP-DRIVER.md §1.5 已档），按用户裁决维持；滞留改良归未来需求（挂账：driver.ts max-tokens 分支）。
  - **done 路径零内容 + max-tokens**（如 MiMo length+0 输入溢出）——不改 done 路径判定；策略插件**内容前置**（零内容截断无可接续点：空 assistant 在 pi-context 被丢弃成「双 user 相邻 + 指令对着不存在的中断」——审查中-1/P8 处置后与救回路径论证对齐）。
  - **指令持久留存的 token 成本与 emergency 吞指令退化**——指令留存投影随后续请求直到压缩吞掉（control 不进摘要，有界；~45 token/次）；emergency 自愈（keep=0）可能把指令本身摘进被替换区间且 directive 不进摘要 → 重试请求无指令，续写退化为普通 continue——已知退化（崩溃级路径，非主路径）。
  - **跨版本读侧**——旧运行时读含 `agent/message` 的新 WAL 整卷拒（SESSION.md §7 既定政策），无跨版本承诺，同版读写。
  - **计数跨 turn 持久化**——spec 收尾归零；崩溃中断的续写轮由 resume 侧 interruptedTurnClosers 闭轮，残留 agent/message 为 directive 类（摘要跳过、UI 隐藏），对后续请求仅少量 token 尾巴，无行为后果。
  - **指令文本的宿主级可配置**——指令是插件常量；宿主可调 `maxOutputContinuations`。
  - **输入侧 overflow 的预防性压缩**（isContextOverflow contextWindow 形态）——文本模式已覆盖主要路径；silent 溢出由既有水位压缩兜底。
  - **UI 重试命令**——host-hub 无 retry 命令面；「可恢复」= `settled{ok:false}` 后客户端再 prompt（既有协议意图）。
  - **send_now 续写期间的延迟语义**——retarget 到 next-step 的条目等续写收束（stopping 窗口或收轮后 kick step0）才消费；成功路径延迟（保序无损），fail 路径搁浅至下次 kick（chainsNextTurn 对 error 不链的既有语义，条目不丢失）。记入核对项与测试，不改行为。

## 并发/一致性预算

- 无新并发面：续写循环在既有串行步循环内；无定时器、无后台任务；插件无可变状态（计数 WAL 现折）；内核新可变状态仅 turn 局部一个布尔（nextStepIsContinuation，与 turnEnds/pendingConclude 同层——跨 turn 自然清零）。
- WAL 事件预算：每次 resume 决策恰一条 `agent/message`（directive）；每次收束决策至多一条；让位不落事件。
- 请求体不变量**不动**：`请求体 = session.deriveMessages() 纯折叠` 原样成立（指令是投影内的表面事件——载体重构的核心收益）。
- 上下文预算：每个无工具截断段最多 3 次续写（缺省 4 次 attempt）；段间计数可复位（续写以 stop+tool_use 收束进入工具段后重新满额）——整轮总量 = 3 × (工具段数+1)，受工具步数调制、无跨段硬上限（与 spec「正常结束归零」一致的既知放大，单段有界）。指令留存：每次截断 +~45 token 至压缩。llm-retry 每 attempt 有限次、overflow 自愈每 (turn,step) 恰一次，与本额度正交。

## 拆分

| 层 | 文件 | 改动 |
| --- | --- | --- |
| llm | `packages/llm/src/types.ts` | `LlmFinish` max-tokens 变体 + `rawReason?`；code 词表注释 + `context-overflow` |
| llm | `packages/llm/src/pi-events.ts` | done 透传 rawReason；errorChunks 判定序重排（救回[带内容前置] → overflow 文本 → 既有链） |
| session | `packages/core/session/src/agent-message.ts`（新模块·子系统单一真相） | kind 闭集常量 + `agentMessageData` 构造器 + 消费谓词（见 docs/AGENT-MESSAGE.md §2） |
| session | `packages/core/session/src/types.ts` | `SessionEventData` 增 `agent/message`（表面第 5 类） |
| session | `packages/core/session/src/gates.ts` | `shapeGates` 增词条（source 非空串、kind 闭集、content text-only） |
| session | `packages/core/session/src/surface.ts` | `SURFACE_TYPES` + `surfaceToMessages` 映射（→ user 角色） |
| agent-loop（内核机制） | `packages/agent-loop/src/tokens.ts` | `agentTurnConclude` waterfall 词条 + 返回形状类型（通用收束窗口，无截断语义） |
| agent-loop（内核机制） | `packages/agent-loop/src/continuation.ts` | 新文件：决策形状门、resume 应用的 agent/message 数据构造 |
| agent-loop（内核机制） | `packages/agent-loop/src/stream.ts` / `step.ts` | Settlement/AssistantSettled 透传 rawReason；续写步相位函数（不领取版 preStep 派发，enter/blocked 闭集）；plugin.ts 接 dispatchTurnConclude |
| agent-loop（内核机制） | `packages/agent-loop/src/driver.ts` | 收束点接线：flow none 后派发钩子 → resume（append agent/message + 续写步重入）/fail/无决策旧路径；粘性赋值移至无决策/工具路径（行为等价重排）；出口不变量与括号/openStep 记账 |
| agent-loop（内核机制） | `packages/agent-loop/src/plugin.ts` / `src/index.ts` | DriverDeps 接 `dispatchTurnConclude`（final `async () => undefined`，样板 = dispatchRequestError）；index.ts 导出 token + 决策类型 |
| 策略插件（新包） | `packages/agent-continuation/`（package.json：`@x-harness/agent-continuation`，deps = agent-loop/core/session workspace:*）+ `src/{plugin.ts, policy.ts, count.ts}` + `__test__` | 截断判定 + WAL 折叠计数（纯函数）+ 指令/source/give-up 常量；waterfall 中间件形态；无可变状态 |
| harness | `packages/harness/src/index.ts` + `packages/harness/package.json` | `continuationKit(options?)` 导出 + dependencies 增项 |
| 装配 | `apps/host-hub/src/worker/assembly.ts` + `apps/cli/src/build-world.ts` | defaultPlugins/装配面 +continuationKit()（各 1 行）；cli 展示面若有按类型渲染核对（agent/message 不展示） |
| compaction（插件内） | `packages/compaction/src/plugin.ts` / `serialize.ts` | 自愈触发词表 `WINDOW_OVERFLOW_CODES`；serialize 用 session 谓词分流（AGENT-MESSAGE.md §3 矩阵） |
| delegation（第四批） | `packages/agent-delegation/src/`（投递面 + 相关测试） | 报告投递从 inject→user/message 迁至 agent/message{source:"delegation-report", kind:"content"}；reportDelivered 记账点随载体迁移；投递时序等价性验证（先探查后小方案） |
| e2e | `packages/e2e/src/output-continuation-journey.ts` + `main.ts` | 旅程挂默认门（真插件装配 + scriptedAdapter 断言请求体末条=指令） |
| docs | **AGENT-MESSAGE.md（子系统规范，已随本方案定稿）**、AGENT-LOOP-DRIVER（§1.2 rewrite 忽略/§1.4 步循环/§1.5 终态词表/钩子表 +agentTurnConclude）、SESSION（表面类型 5、词条 21）、COMPACTION（serialize 分流 + 自愈两码）、LLM、LLM-PI、PLUGIN-AUTHORING（引用 AGENT-MESSAGE.md + 已知来源表 + agentTurnConclude 中间件纪律）、agent-delegation notify 词表注释 + 本文档 | 行为叙事与词表同步 |

依赖方向：agent-continuation → agent-loop/session；agent-loop → llm/session；compaction → 既有；harness 聚合。host-hub 改动收敛为装配 1 行，核对项：`settled` 对 error 终态已 `ok:false`；`assistant/message.stopReason` 透传已就绪；`agent/message` 经 WAL 镜像泛型外发（类型即 UI 隐藏语义，零过滤代码）；cli 展示面按类型渲染时跳过 agent/message；send_now 延迟语义（见问题域，测试钉死不改行为）。

## 实施顺序

1. **llm 信号归一批**：types/pi-events + 表驱动测试（独立可回滚，纯加法；http-413 既有用例中带 overflow 文案者预期改判 `context-overflow`）。
2. **类型与内核机制批**：session（agent-message.ts 单一真相模块 + types/gates/surface 第 5 类 + 测试）+ agent-loop（tokens/continuation/stream/step/driver/plugin 接线）+ 机制测试（假策略中间件驱动 resume/fail/无决策三态 + 窗口结构保证回归）+ compaction serialize 分流。
3. **插件与收尾批**：agent-continuation 包 + harness kit + 两处装配 + 插件策略测试 + compaction 自愈触发词表 + e2e 旅程 + 文档（delegation 节除外）+ 对抗审查（代码 diff 轮）。
4. **delegation 迁移批（用户裁决并入）**：探查三问落锤——①投递时点：保留 inbox 排队+唤醒语义（直接落卷不会唤醒空闲父代理），载体经条目材料化（InboxEntry.origin → 领取时落 agent/message）；②reportDelivered：记账点不变（入队成功即交付）；③inject 为零消费者死 API——删除，新增 `agent.notify(source, kind, text)`（排队+唤醒+材料化标记）。fork 种子 content 继承/directive 丢弃。

每批四门全绿独立提交；无过渡态（max-tokens 无工具分支被「派发钩子，无应答走旧路径」取代；旧路径仅作无插件缺省语义存续，非双轨：同一分支点，策略外置）。

## 裁决

- **内部消息 = 持久类型化表面事件 agent/message（用户裁决·载体重构轮，推翻初版「log-only 审计 + 请求期尾部」）**：尾部拼接为 exactly-once 修改了请求体纯折叠不变量、引入 AttemptInput 传值/消费纪律/防泄漏一串机制；持久类型让投影自动携带、不变量原封不动、内核机制净简化，且成为通用基元。代价（用户接受）：指令留存投影随后续请求直到压缩吞掉（directive 不进摘要，有界）；emergency 压缩可能吞指令（已知退化）。原 spec「只进恰一条请求」的瞬态性正式放弃（用户修订）。
- **开闭扩展契约：source 开放、kind 封闭（用户裁决·「易于后续扩展」的落点）**：未来内部消息 = append agent/message（自带 source、选 kind），三消费方（模型/UI/摘要）零改动接入；禁止消费方按 source 分支（只作诊断）；kind 闭集 {directive, content} 按「是否须存活于摘要」二分——真出现第三种摘要行为才扩闭集。
- **内核只认时点、不认截断（用户裁决方向·二次收紧）**：派发点 = 无工具 settle 收束时点（循环结构事实）；「tool_use 不续写」由结构保证；计数归插件 WAL 折叠。llm 层救回词表是 provider 方言归一（refusal/sensitive 同层职责）非业务逻辑，且载荷带 rawReason 不锁死未来词表。
- **内核机制 + 策略插件（用户裁决方向）**：纯插件在现行钩子面不可达（agentTurnStopping 仅 completed 派发；agentAssistantSettle 改写即伪造落账值；turn 终态无插件通道；收件箱整批领取混流）——内核补通用收束窗口，策略全部外置；无插件行为逐字节等于现状（真 opt-in）。
- **原生 reason 救回在 llm 层且带内容前置**（默认裁决）：方言归一单一真相点；零内容截断错误分流 overflow 自愈，防空消息与语义自相矛盾的续写。
- **overflow 文本分类优先于状态码**（默认裁决）：400+文案主力形态落 http-400 则自愈永不触发；413 文案改判行为等价（两码皆收），审计码更语义化。
- **`model_context_window_exceeded` 按形态分流**（用户裁决 + 审查处置）：有 partial 内容 → 截断续写；零内容错误文本 → context-overflow 响应式压缩。两分支各对 spec 第二/六步。
- **`max-tokens + tool_use` 行为不变**（用户裁决 + 存量语义）。
- **放弃错误走 turn/error 终态**（默认裁决）：`turn/end{reason:error,code}` + `agent/error` + `settled{ok:false}`；message/code 由策略插件给定（缺省 `output-token-limit`）；不另造错误消息事件。
- **计数复位取 spec 字面语义（stop 即归零），实现住插件 WAL 折叠**（默认裁决）：预算如实按段级有界表述；不加跨段硬上限。
- **续写步 preStep rewrite 忽略、reject 跳回灌、empty 不可达**（默认裁决）：相位闭集钉死。
- **delegation 迁移并入本功能第四批（用户裁决，推翻「挂账另立需求」默认裁决）**：报告载体 user/message → agent/message{kind:"content"}，UI 隐藏与摘要归档随类型自动成立；投递时序三问（边界控制/reportDelivered/inject 形态）批内先探查后小方案，独立审查轮不省。

## 测试口径

**llm/pi-events（表驱动）**

- done：`reason=length` → max-tokens + rawReason 透传（anthropic `max_tokens` / openai `length` / responses `incomplete.max_output_tokens` 三态）；无 rawStopReason → 字段缺席。
- error 救回：rawStopReason ∈ 三词表 + 有内容 → `{kind:"max-tokens", rawReason}`，partial 保留、usage 先行；**零内容 → 不救回**落 overflow/error 链（`model_context_window_exceeded` 零内容 → `context-overflow`）。
- overflow 优先级：`prompt is too long` + status 400 → `context-overflow`（非 `http-400`）；`request_too_large` 413 → `context-overflow`；纯 413 无文案 → `http-413`（保持）；throttling 排除集不误判；refusal/sensitive/content_filter 仍不可重试；网络文案仍 `network`。

**session（types/gates/surface）**

- `agent/message` 正形（source 非空、kind ∈ 闭集、content text 块）append 过门并投影为 user 角色消息；image 块拒（`shape:agent/message`）；kind 垃圾值、source 空串、缺字段 → 拒。
- surfaceToMessages：agent/message 映射 user 角色；投影纯函数回归（既有四类不受扰）。

**agent-loop 内核机制（假策略中间件 + scriptedAdapter + calls 捕获）**

- 窗口契约：无工具 settle 收束点派发恰一次、载荷 {turn, step, stopReason, content, rawReason?}；stop settle 同样经窗口（让位 → 现状不变）；带 tool_use settle **不派发**（结构保证钉死）；undefined → 旧路径；非法形状 → fail-loud；signal 断 → 让位。
- resume 应用：**续写请求的 messages 末条恰为指令 user 消息**（calls 断言，文本=插件 instruction；来源=投影非拼接——WAL 中有对应 agent/message）；`agent/message{kind:"directive"}` 恰一条；**turn/end `{kind:"completed"}`**（出口不变量）；后续 turn 的请求仍含该指令（持久载体语义钉死）+ 空收件箱续写步仍发请求（empty 不可达）。
- fail 应用：turn/end `{kind:"error", message/code = 插件给定}`；partial 全落账；step/end 括号配对完整（含 fail 步）。
- 无决策：现行行为逐字节回归（stop→completed 走 stopping 窗口；max-tokens→粘性收轮、无 agent/message、无续写）。
- 带工具的 max-tokens settle：工具执行、粘性收轮、不经窗口（回归钉死）。
- 暂停吸收与保序：截断后 steer 入队 → 续写请求不含该条目且**指令为末条**（顺序断言）；续写完成后 stopping 窗口消化条目（不搁浅）。
- 续写返回 stop + tool_use：工具步后请求体含指令（持久载体——非陈旧泄漏，断言其位置在截断 partial 之后）。
- abort 于续写流：interrupted partial 落账 + aborted 收轮；fail 竞态：截断结算后 cancel 落入分支内 → aborted 收轮（fatalOutcome 复用）。
- 续写请求 413/overflow：假 agentRequestError 返 retry → 重试请求仍含指令（自愈重试不落 agent/message）。
- 续写步 preStep 否决 → blocked 收轮（无回灌 insert 噪音断言）。
- resume：崩溃残卷含 agent/message{directive} → resume 后投影含它（确定性重放）且不重复注入。

**agent-continuation 插件（策略单测）**

- 截断判定：stopReason "stop" → 让位；"max-tokens" → 进计数。
- count/max 矩阵（WAL 折叠纯函数）：无 stop settle 时 0..max-1 → resume（指令常量逐字节）、=max → fail（message/code 常量）；0 → 首次即 fail；stop settle 后归零（段间复位）；跨 turn 不串（turn 边界）；agent/message{source 命中} 恰计一次（其它 source 不计）；signal 断 → 透传下游；next 纪律（不调 next 即内核 throw——契约测试）。

**compaction**

- serialize：directive 跳过（摘要无指令）/ content 内容行（用假 content 消息断言进摘要）；cut：agent/message 非切口候选（回归）。
- 自愈：`context-overflow` 码触发（假失败注入 → emergency 压缩 + retry 一次）；纯 `http-413` 回归保持。

**host-hub（核对性测试，装配外零改动验证）**

- send_now 续写窗口：retarget 成功、延迟消化（成功路径）；fail 后条目存活由下次 kick step0 消费。
- `agent/message` 经镜像外发为同名事件（客户端按类型隐藏的协议面）。

**e2e（默认门旅程，真插件装配）**

- 全真装配：两段截断→stop 续写旅程 + 四连截断放弃旅程；断言 settled 形态、WAL 事件序（assistant/message → agent/message → step/end）、get_entries 中指令以 agent/message 类型呈现（非 user/message）。

## 审查处置（文档轮，2 并行子代理，问题清零；词表与结构随后续轮次演化，本节保留当轮措辞）

- 高-1 overflow 分类与状态码优先级未定义（400 主力路径绕过自愈）→ 采纳：判定序钉死，测试补 400/413 两形态。
- 高-2 `model_context_window_exceeded` 与 pi 输入侧分类矛盾（错判烧额度）→ 采纳：按形态分流（内容前置）。
- 中-3/高-1(状态机) resume 分支未禁粘性赋值（mergeOutcome 单调性误收 max-tokens 轮）→ 采纳：出口不变量入契约。
- 中-4 空内容救回边界（空 assistant/message + 双 user 相邻）→ 采纳：hasContent 前置，零内容分流 overflow 链。
- 中-5 拆分漏 session/types.ts；词表基线计数错 → 采纳：补行、按 20→21。
- 中-6 跨版本读侧整卷拒是既定政策 → 采纳：问题域点名。
- 中-2(状态机) 计数归零与预算矛盾（段间复位无硬上限）→ 采纳：段级有界表述。
- 中-3(状态机) 续写步 empty 早退误收 completed → 采纳：相位闭集 + 测试钉死。
- 中-4(状态机) 放弃分支未闭 step/end → 采纳：同 dialFailure/fatal 形状。
- 中-5/低-10(状态机) rewrite 未定义 / reject 回灌噪音 → 采纳：rewrite 忽略、reject 跳回灌。
- 中-6(状态机) send_now 延迟语义未覆盖 → 采纳：核对项 + 测试，不改行为。
- 低-7(状态机) openStep 复位遗漏 → 采纳。
- 低-8(状态机) 尾部消费时点缺口 → 采纳（载体重构后该机制整体删除——问题随载体消失）。
- 低-9(状态机) 放弃与 cancel 竞态 → 采纳：fatalOutcome 复用。
- 低-7(契约) LlmRequest.messages 恒等注释 → 已随载体重构失效（不变量不动，无需修订）。
- 低-8(契约) emergency 吞 partial 退化 → 采纳：问题域记已知退化（载体重构后扩展为「可能吞指令」）。
- 低-9(契约) delegation notify 词表 → 采纳：文档同步行。
- 确认面（30+ 项）：无需改动，落入各节引用。

## 审查处置（分层修订增量轮，1 子代理，问题清零——用户质询「为何不是插件」触发分层重构）

- 插件处理器缺 waterfall next() 纪律 → 采纳：中间件形态钉死，让位 = 透传下游。
- 形状门先例引用自相矛盾（isDialShape 是 fail-loud）→ 采纳：undefined→旧路径 / 垃圾→fail-loud 两分。
- resume 空 instruction 无 driver 侧门 → 采纳：形状门纳入非空校验。
- 词条样板引错近亲（agentTurnStopping 是 defineSerial）→ 采纳：样板 = agentRequestError + dispatchRequestError。
- 三处注册面缺行 → 采纳：拆分表补行。
- serial/waterfall 错误语义差异 → 采纳：PLUGIN-AUTHORING 补纪律。
- 确认面（7 项）：scope 可见性、零 inject 可行、构建/测试自动纳入、kit/装配位、逃逸 throw 兜底、abort 接线、deepFreeze——无需改动。

## 审查处置（内核零策略收紧轮自查——用户质询「内核是否写死功能」触发）

- 内核残留①：截断派发条件是功能判定 → 采纳：通用收束时点，判定归插件，tool_use 排除变结构保证。
- 内核残留②：计数/复位是 spec 策略 → 采纳：内核不计数，插件 WAL 折叠。
- 钩子名 agentTruncation 烙功能名 → 采纳：改 agentTurnConclude；决策词表 give-up → fail。
- llm 救回词表审定为方言归一非业务逻辑，载荷带 rawReason 不锁死。
- 副产：窗口通用化解锁非截断复用。

## 审查处置（载体重构轮——用户裁决「持久类型化消息 + 通用可扩展基元」，自查处置）

- 载体从「log-only 审计 + 请求期尾部拼接」改为持久表面类型 `agent/message`：请求体纯折叠不变量原封不动（撤销初版的 ⊕ 尾部修正案）；AttemptInput tail/消费纪律/防泄漏机制整体删除；内核状态缩减为一个布尔。
- 开闭契约成形：source 开放（消费方禁按其分支）、kind 封闭 {directive, content}（按「是否须存活于摘要」二分）；compaction serialize 一处分流、cut 零改动。
- 代价落档：指令持久留存至压缩（~45 token/次）；emergency 可能吞指令（已知退化）；原 spec「恰一条请求」瞬态性正式放弃（用户修订）。
- `agent/continuation` 审计词条取消（agent/message 即审计；fail 记录 = turn/end{error}）；WAL 词条净增仍为 1（agent/message）。
- delegation 迁移与宿主写入 API 挂账另立需求（涉投递边界语义与 reportDelivered 记账）。
- kind 值命名修正 control → directive（用户质询暴露歧义：「control」读作「系统内部消息」会误吞子代理报告类；directive=指令（喊话，过期作废）/ content=内容（情报，必须归档），UI 隐藏仍是整个类型的语义、与 kind 无关）。
- delegation 迁移从挂账提入第四批（用户裁决）：报告载体迁移 + reportDelivered 记账点迁移 + 投递时序等价性验证；批内先探查后小方案，独立审查轮保留。

## 审查处置（代码轮，2 并行子代理，问题清零——批 1-3 diff）

- P1 限流误吞（中高）：overflow 文本分类先于状态码会把 429+「too many tokens」类限流文案误判 context-overflow → 不重试 + emergency 压缩 → 采纳：429/503 状态码在场时跳过 overflow 文本分类（限流与溢出码 400/413 干净分离）；回归测试钉死网关转发无前缀形态。
- P3/零内容救回落空归 network（中）：rawStop ∈ 三词表且零内容 → context-overflow（确定性失败不盲重试；输入压力由自愈恰一次兜底）→ 采纳。
- 中-1/P8 done 零内容续写自相矛盾（中）：策略加内容前置（content.length===0 → 让位现行粘性路径）→ 采纳；问题域措辞同步。
- P6/低-2 gate 放行 tool_use 块（低）：越约块被三消费方静默吞成无痕数据损失 → 采纳：isTextOnlyBlocks fail-closed + 测试补 tool_use 反例。
- P5 store 缺席 count=0 fail-open（低）：理论上开无限续写面 → 采纳：会话不可寻址即让位（不把「读不到账本」当「账本为零」）。
- P4 双策略件优先级未文档化（中低）→ 采纳：PLUGIN-AUTHORING §1.5 补「装配序在后者应答胜；覆盖件须装配在 continuationKit 之后」。
- P7/低-3 搁浅指令「无行为后果」措辞乐观 → 采纳：AGENT-MESSAGE §7.1 已知代价点名 blocked/fatal 确定性残留路径。
- P2 z.ai 429 文案真溢出（pi 库局限）→ 采纳：LLM-PI.md 已知局限记录，水位压缩兜底。
- 低-4 三元全序断言缺口 → 采纳：暂停吸收用例补 partial < 指令 < steer 下标断言。
- P9 next 纪律契约测试缺失 → 采纳：插件包补「不调 next → 内核 throw → error 收轮」用例。
- 挂账（第四批）：agent-delegation/lineage.ts recastSurface default 静默丢 agent/message——父轮 directive 不进子种子正确，delegation 迁移 content 时需补 case。
- 确认面（两审合计 20+ 项）：hasContent 双侧口径一致、粘性重排逐路径等价、TurnState 无丢失读写、出口不变量结构成立、出口闭集、steer 不搁浅、指令末条结构保证、存量消费方中性扫描（cut/occupancy/scavenger/repair/telemetry/archive）、嵌套压缩竞态「摘 partial 留指令」不可达、自愈词表行为等价、测试非假绿——无需改动。

## 审查处置（批 4 轮，1 子代理，问题清零——delegation 迁移 diff）

- P1 崩溃复活双交付（高）：trailingClaims 只认 user/message 作消费标记——纯 notify 批次材料化只落
  agent/message，崩溃恢复把已交付报告当 trailing claim 复活重投 → 采纳：agent/message 同为消费标记
  （repair.ts）+ 回归测试（纯内部消息批次消费后崩溃不复活）。
- P2 notify 守卫不完备（中）：非串 source/越界 kind 会 append-failed throw 而非降级 → 采纳：守卫补
  typeof source + AGENT_MESSAGE_KINDS 闭集（与 steer 同款完备）。
- P3 preStep 改写丢 origin 契约缺口（中低）：transformMessages 典型写法丢 origin → 内部消息降级
  user/message（UI 泄漏）→ 采纳：plugin-api docblock + tokens 契约注明「改写须保留 entry.origin」。
- P4 门不一致（低）：inbox 条目 origin+image 过门但 agent/message 门 text-only → 材料化中途炸 →
  采纳：带 origin 条目入口即 text-only 收口（失败点不后移）。
- P5 纯未标空批例外（低）：全空 content 条目（唯 preStep 改写可达）不再落空 user/message → 采纳为
  语义改进，注释钉明。
- P6 plain 类型谎言（信息）：cast 标错类型（运行时不丢块）→ 采纳：plain 收敛 ContentBlock[]。
- 混批三事件交错形态（steer,notify,steer → user,agent,user）确证代码正确、测试补强留为小缺口（前缀
  序已钉）。
- 确认面（12 项）：纯未标批逐字节等价、origin 端到端完整（insertData→WAL→fold→回灌→材料化）、
  gates 正反例、notify≡steer 唤醒同构、deliver 等价（reportDelivered/emitFinished/孤儿/tearing-down）、
  recastOne 逐类型等价（seq 连续/system 特赦）、假绿抽查通过、inject 删净、消费面就位、fork 种子分流。

## 验收清单

- [ ] 截断信号归一：归一 length ∨ 原生三词表（error 救回带内容前置）；带 tool_use 的 settle 不经收束窗口（结构保证）
- [ ] overflow：`context-overflow` 码（400 文案优先于状态码）+ compaction 自愈恰一次；llm-retry 不重试该码；纯 413 保持 `http-413`
- [ ] agent/message 类型：形状门正反例（source/kind/text-only）；投影 user 角色；UI 隐藏 = 类型语义（镜像泛型外发）；serialize directive 跳过 / content 内容行；cut 非候选
- [ ] 窗口契约：无工具 settle 恰派发一次（stop 与 max-tokens 都经窗口）、载荷纯事实；undefined → 现行行为逐字节回归（真 opt-in）；非法形状 fail-loud；next 纪律契约测试
- [ ] partial 保存先于判定：放弃路径 4 条 partial 全落账，stopReason 逐条 `max-tokens`
- [ ] 指令载体：续写请求 messages 末条 = 指令（来自投影非拼接）；WAL 有对应 agent/message{directive}；后续请求持续含之（持久语义）；自愈重试不重复落
- [ ] resume 出口不变量：`turnEnds === undefined`，续写成功轮 `turn/end{completed}`，链式不断
- [ ] 续写步：不领取不落批次、empty 不可达、rewrite 忽略、reject 不回灌；括号/openStep 记账配对（含 fail）
- [ ] 插件策略：stopReason 判定（stop 让位/max-tokens 进计数）；WAL 折叠计数（段内上限缺省 3、stop 复位、turn 边界不串、按 source 精确计数）；=max → fail；0 禁用；signal 断让位
- [ ] 暂停吸收与保序：续写请求不含排队条目且指令为末条；stopping 窗口不搁浅；send_now 延迟语义核对通过
- [ ] 放弃：error 终态（插件 message/code）+ UI `agent/error` + `settled{ok:false}`；cancel 竞态按 aborted
- [ ] delegation 第四批：报告以 agent/message{content} 落账、UI 不再出现 user/message 形态报告、模型可见性不变、reportDelivered 语义不破（复读/异常窗口回归）
- [ ] `max-tokens + tool_use` 现行为逐字节回归
- [ ] 四门全绿 + 覆盖率 ≥90/85 只升不降，数字如实报告；e2e 旅程默认门通过
- [ ] 对抗审查（文档轮已完成清零 + 代码轮）问题清零
