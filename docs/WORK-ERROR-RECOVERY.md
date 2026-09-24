# 工作错误恢复（L2）与内核零策略整改方案

> 状态：草稿（双域审计已并入——审计 A：agent-loop/llm 八项分级；审计 B：core/harness 九面三问标准；待三路对抗审查后定稿）
> 关联：docs/OUTPUT-TOKEN-CONTINUATION.md（续写轨道——本件扩其入口）；docs/TRUNCATED-TOOL-RESCUE.md（截断配对——本件②吸收其文案外提）；docs/AGENT-LOOP-DRIVER.md；docs/LLM-RETRY.md
> 级别：中偏高（内核三处接口改造 + pi-events 处置序下放 + 新插件包 + 文案外提 + 词表收口）
> 来源：用户方案（工具调用失败不直接退出——错误回模型自愈，连续 3 次同类失败才退出，成功重置）+ 内核零策略违宪审计（宪法 = agent-loop/src/continuation.ts 头注：「窗口派发 + 决策应用。策略（何时续/续几次/指令文本/放弃文案）全在插件——内核零策略、零截断语义」）。

## 问题定义

### 用户方案（L2 错误恢复）

现状断层：工具级错误回模型自愈 ✅（既有）；传输层重试 ✅（llm-retry，瞬时错误 ×3 退避）。但**重试耗尽 → fatal 直接收轮，模型永远看不到错误**；带工具 max-tokens 粘性收轮同理（事故复盘：会话 140734，seq 291——完整工具块执行被 FS_NOT_OBSERVED 拒 + 零字符截断块被旧代码折 `{}` 撞 TypeBox → 两个错误落卷 → 粘性收轮 → 任务死，模型无人读卷）。

目标漏斗：

```
L1 传输层（既有，不动）：瞬时错误退避重试 ×3 —— llm-retry
L2 模型自愈层（本件）：重试耗尽/带工具截断/工具连续失败
    → 不收轮，错误以模型可见形态回卷，下一轮模型应对
    → 连续 3 次同类失败才升 L3；任一真实成功重置计数
L3 真退出（收紧）：fatal 收轮，终态携带累计失败摘要
```

### 违宪清单（双域审计合并，一波整改）

**裁决标准（审计 B 三问，后续一切判定沿用）**：①协议耦合（改值需改协议文档才可住内核）②无部署差异维度（无宿主合理想要不同值）③安全下限而非体验调参（去掉击穿内核自伤防线）。文案二分：判别符式短码（`invalid-request`）内核合法；面向模型的**解释+行为指令长文**住「决策所在层」。

| # | 位置 | 违宪项 | 判定 | 严重度 | 整改 |
|---|---|---|---|---|---|
| V1 | agent-loop/driver.ts:158-159 | 带工具 max-tokens 粘性终态——收束窗口**结构不可达**（无契约的内核裁决；对照 :157 是 tokens.ts:103 背书的让位缺省，合法） | 违宪 | 高 | 内核改接口：带工具路径也派发收束窗口（payload 增 hasTools/truncatedCount 事实）；粘性决策移 agent-continuation 的让位 final |
| V2 | agent-loop/tool-calls.ts:38 + repair.ts:31-32 | 策略文案住内核（TRUNCATED_TOOL_MESSAGE 的行为指令句、repair 两句恢复文案、ABORTED_BEFORE_DISPATCH、`tool-not-allowed:`）；agentTruncatedTool 只能追加 note 不能替换 | 违宪 | 中 | 文案外提：内核只落协议性短事实（`truncated: not executed` 等）；行为指令做成缺省文案插件（agentTruncatedTool 应答升格可替换 content）；ARGS_ECHO_MAX_CHARS 补参数化后门（`formatArgsEcho(args, max=2_000)`——维持批 1a 裁决，同族条款补齐） |
| V3 | agent-loop/attempt.ts:168 + tokens.ts:92 | agentRequestError 决策集仅 `{retry}`——「重试耗尽=死」写死，无 respond/fail 接口；fatal 还丢 code（settlement.code 不透传） | 违宪 | 中 | 内核改接口：决策集增 `{kind:"respond-to-model", message}` 与 `{kind:"fail", message, code}`（与 TurnConcludeDecision 对齐）；fatal 透传 code |
| V4 | llm/pi-events.ts:219-247,269-273 | 词表 OUTPUT_LIMIT_RAW_REASONS 本身=wire 事实归一（合规）；违宪在**判定序**——救回条件（hasContent）、零内容→context-overflow、429/503 保护序引用 compaction 语义（「瞬态不得换走 emergency 压缩」是 llm 出口层替 compaction/llm-retry 编排） | 违宪（判定序） | 中 | 混合：llm 只报事实字段（rawReason/statusCode/overflowPattern 命中各自独立）；救回与溢出处置序下放消费端（compaction 的 WINDOW_OVERFLOW_CODES 可承接；「不盲重试」= llm-retry 的 retryableCodes 不含该码即可） |
| V5 | agent-loop/step.ts:360 + tool-calls.ts:46 | 截断判定+分区（TRUNCATED-TOOL-RESCUE 争议项④重裁） | **边缘→机制**（双审计一致裁定：JSON 完整性协议检查+配对保投影闭合+none 逃生门=机制；但辩护不及文案 V2 与混合粘性 V1） | 低 | 不动 |
| V6 | core/session/gates.ts:219,137,74-76 | 词表字面量与 types.ts 联合类型双写（ThinkingLevel/TODO statuses/InboxTarget）——llm 扩档位 → 新 request/header 被门拒 → 整卷假 corrupt（fail-closed 放大） | 边缘 | 低 | 词表常量下沉 core/session/tokens.ts 单一出口，两侧 import（AGENT_MESSAGE_KINDS 已是正确示范） |
| V7 | llm/pi-events.ts:55-79 | refusal/鉴权落无 code——「无码」成为隐式不可重试信号（语义双载） | 边缘 | 低 | 显式 `non-retryable` 事实码 |
| V8 | llm/pi-adapter.ts:23-28 | THINKING_BUDGETS 数值（2048/8192/16384 调参策略数） | 边缘 | 低 | 接受为适配器缺省或挪模型目录（低优先，随触碰收口） |

合规确认（不动的面——对抗审查 C 补两条）：inbox 领取序（next-turn 只领队首 + next-step 全部）= 队列消费序机制、投递目标策略在调用方（agent-delegation）；host-hub worker 看门狗/entries-window = 宿主层合法豁免（RETRY_POLICY 同判）；V5 分区机制、gates synthetic 三态门（「语法归 core、语义归写方」）、deny 决策链（形态门 vs 内容 100% 归 permission）、投影降 {}（真相在 journal，派生层降级不销毁证据）、telemetry fold 形状、装配面（toolboxKit 装配条件/RETRY_POLICY 在 apps/cli 属合法层）。

## 契约

### C1｜agentRequestError 决策集扩展（V3——L2 的接口面）

tokens.ts 决策类型从 `{kind:"retry"} | undefined` 扩为：

```ts
{ kind: "retry"; dial?: Partial<Dial> }
| { kind: "respond-to-model"; content: string }   // 错误落卷为模型可见消息，下一轮应对（不重拨）
| { kind: "fail"; message: string; code: string }   // 显式收轮（终态带 code——修透传丢失）
| undefined                                        // 让位 → final（现行 fatal 语义成为缺省）
```

attempt.ts:168 改道（对抗审查 A P0——返回形状重写）：**新增 `AttemptResult` 分支 `{kind:"continue"}`**——respond-to-model → appendSurfaceEvent 落 `agent/message{kind:"content", source:"error-recovery", content: 脱敏后错误文本}`（AGENT_MESSAGE_KINDS 既有 kind，摘要可见）+ 返回 `{kind:"continue"}` 令 driver **直接进下一迭代、不过 concludeStep**（复用 ok/message 分支会携不存在的 assistant settle 进收束窗口——stopReason 语义悬空，A 审查证实的结构错位）；fail → fatal（带 code）；undefined → 现行 fatal（缺省安全）。形状门同 isResumeDecision 风格（fail-loud 垃圾收轮）。

**waterfall 链序事实（A 核实）**：runWaterfall 是洋葱链非首答获胜——llm-retry 先 `await next()` 再以 retry 覆盖，故重试期 respond 被吞、耗尽后生效（互斥成立）；但 **error-recovery 的计数在 L1 重试期已被下游链路走满**——修：计数仅在自身应答未被覆盖（respond/fail 真生效）时递增，或仅对不可重试码计数（实现二选一随批 B+C 定，测试钉死「L1 三次重试不预烧 L2 预算」）。

### C2｜收束窗口全路径可达（V1——L2 的截断入口）

driver.ts:158-159 删除；带工具 max-tokens 与无工具路径同走 concludeWindow 派发——**ran 流新增派发点，位置规格：tool/result 全部落账之后**（C5「工具结果全 isError」判定的输入前提；工具前派发则判定无输入）。payload 增纯事实字段 `hasTools: boolean`、`truncatedCount: number`（分区已有数据，透传）；`ContinuationDecideInput` 增 `hasTools?`（贯通 policy 判据）。**改动面补 agent-continuation（A/C 双审确认的遗漏）**：policy.ts 判据 `hasTools && 无完整结果待消化 → undefined（让位 final）`——与 ZCode `toolCallCount > 0 → none` 同判，从内核裁决变插件决策；批 A 原子交付（见拆分节）。新插件 error-recovery 可对「工具全失败 + max-tokens」答 resume。「让位 final 等价」回归测试在**默认装配**（含 agent-continuation）下钉死。

### C3｜文案外提（V2）

- 内核只落协议短事实：tool-calls 配对文案改 `truncated: not executed`；repair 两句改 `outcome unknown` / `not started`；`tool-not-allowed:` 维持（判别符短码）。
- 新 `createDefaultTruncationMessages()` 独立包（packages/truncation-messages——C 审查裁决落点）：挂 agentTruncatedTool，返回 `{content}` **替换性**完整文案（行为指令句 + 场景化建议）。
- **并存裁决（A P2）**：内核短事实 = **插件缺席时的保底**（非恒定前缀——缺省装配文案插件在场则 WAL 落插件文案，短事实路径由「无插件世界」测试钉死非死代码）；应答 `{content}` 与 `{note}` 同答时 **content 生效、note 丢弃**（替换优先于追加——rescue-plugin 单返 note 的既有语义不变，两插件同时在场时文案插件先答 content、rescue 后答 note 的链序由装配序定，装配契约写明）。
- `formatArgsEcho(args, max = 2_000)` 参数化。

### C4｜pi-events 救回收窄为 wire 归一（V4 重裁——对抗审查 A P0：处置序下放两头不沾）

**重裁**：OUTPUT_LIMIT_RAW_REASONS 词表与「error→finish{max-tokens} 救回」**留在 llm 层**——判定收窄为方言 wire 归一（openai mapStopReason 把 max_tokens 折 error 是 pi 的方言事实，归一为跨方言一致的 finish 语义属适配器职责，与 refusal/sensitive 归一同性质）。A 审查证实的下放不可行性：救回发生在 chunk 出口（早于 settleStream/attempt），agentRequestError 面无法重建 max-tokens settle；C1 决策集无「以截断 settle 落 partial」表达；C5 挂载面不含 agentLlmStream——三重断裂。**V4 违宪项收窄为**：救回判定序中的「429/503 保护序 + 零内容→context-overflow」两处编排语义（引用 compaction/llm-retry 的推理）——处置：保护序删除（429/503 在场时溢出 pattern 命中照报——消费端 llm-retry 按 retryableCodes 自会优先重试，无需出口层代编排）；零内容→context-overflow 维持（它是终态分类非编排）。llm 契约注释删除 compaction 语义引用。

**字段管道（保留 B P0——C5 分类输入）**：`LlmFinish{kind:"error"}` 增 `rawReason?`（error 事件 payload 已有 rawStopReason——透传）→ `Settlement` attempt 分支增 `rawReason?` → `RequestFailure` 增 `rawReason?`——三级透传供 error-recovery 区分「真错误 vs 未救回的边缘截断形态」，用例钉死。

### C5｜error-recovery 插件（L2 策略体，新包 packages/error-recovery）

- 挂 agentRequestError + agentTurnConclude 双窗口：
  - **requestError**：重试耗尽后分类——可恢复类（工具连续失败跟随的错误/http-4xx 语义类/网络细节）→ `respond-to-model`（错误摘要 + "if this error persists, stop and report" 第二次起附加）；环境死错（auth 过期/context 超限且 compaction 已自愈过）→ `fail`；
  - **turnConclude**（经 C2 可达的新入口）：`stopReason===max-tokens && hasTools && 工具结果全 isError` → `resume`（指令复用续写轨道 + 失败摘要）；
- 计数器（语义钉死——B P0 + A P1 双审）：**键 = 错误族四桶**（transport-retryable / http-4xx / auth / context-overflow——裸 code 分桶则 429/network 交替永不达 3，A 实锤）+ **不分族总连续失败上限 ×5 封顶交替循环**；分族 ×3 升 fail；**清零条件 = 工具成功执行 或 assistant 正常 stop**（「模型合法新调用」不作清零——新调用失败=递增，flaky 工具与反复撞错场景（事故画像）都会正确升级）；工具面键 = toolName+isError，**禁 callId**。
- respond 消息载体（B P1）：落 `agent/message{kind:"content", source:"error-recovery"}`（UI 隐藏、**摘要可见**——错误须存活于压缩摘要，落 user/message 会污染 UI）；错误文本过脱敏层（URL/凭据模式剔除——pi errorMessage 含 fetch 端点信息，现状 llm/retry 落 WAL 无脱敏先例，respond 面新增脱敏并同款补齐 llm/retry）；respond 面遥测打标。
- 成本裁决（B P2）：**网络/5xx 类不 respond 直接 fail**——llm-retry 已试 ×3，再 respond 只烧 token；仅工具级/语义 4xx 类进 respond。
- 窗口链序（C 审查）：error-recovery 挂 agentRequestError 须声明「llm-retry 耗尽后」观察方式——经装配序（llm-retry 先注册先应答 retry，耗尽后让位 undefined，error-recovery 后手见事件）；写进插件装配契约。
- compaction 自愈账本（C 审查）：死类判定「context 超限且 compaction 已自愈过」需读自愈状态——通道 = journal 派生事实（扫描卷内 compaction 事件），C5 实现细节节成文。
- 装配：**三处**（harness kit + apps/cli/build-world + apps/host-hub/worker/assembly）。
- 配置：`maxConsecutiveFailures`（缺省 3）+ **recoverable/dead 分类词表覆写面**（RETRY_POLICY retryableCodes 同款——宿主可纳 auth 过期等，堵 V8 同病）——装配面参数。

### C6｜词表收口（V6）+ 显式 non-retryable（V7）

gates.ts 词表字面量下沉 core/session/tokens.ts 常量（ThinkingLevel/TODO statuses/InboxTarget），types.ts 与 gates 两侧 import 单一出口。pi-events refusal/鉴权改显式 `non-retryable` 码。

## 问题域

- 处理：C1-C6 六契约 + error-recovery 新包 + 文案插件。
- 不处理：
  - L1 传输层重试（llm-retry 既有——不动）；
  - V5 截断分区（双审计一致裁定机制，维持）；
  - V8 THINKING_BUDGETS 挪目录（低优先，随触碰）；
  - tools dispatch 的 ARGS_ECHO_MAX_CHARS 调参化（C3 已给后门，缺省不动——批 1a 裁决维持）；
  - base-prompt 产品话术（kit 级合法缺省）。

## 并发/一致性预算

- 计数器进程内 per-session（llm-retry budgetKey 同款），无跨进程面。
- respond-to-model 落卷经 appendSurfaceEvent（既有原子面）；连续 respond 死循环由 ×3 上限封顶。
- C2 改道后无插件装配的世界：agent-continuation 让位 → final 粘性（行为等价现行——缺省安全）。

## 测试口径

- 决策集：respond/fail/retry/让位四路形状门；fatal code 透传。
- C2：带工具 max-tokens + continuation 插件 → 窗口派发可达（payload 事实字段断言）；让位 final 行为等价旧粘性（回归）。
- error-recovery：可恢复类 → respond（错误消息落卷模型可见断言）；死类 → fail；×3 升级；成功重置；max-tokens+工具全败 → resume。
- 文案插件：替换生效；rescue note 追加不变；内核协议短事实回归。
- pi-events：事实字段独立输出；旧判定序删除后的回归（救回行为由消费端测试背书）。
- 词表：ThinkingLevel 扩档位 → gates 不再假 corrupt。
- e2e：模拟「工具连续失败 ×3」全路径（L2 接管 → 第 4 次 fail 收轮）；「失败后模型自愈成功」计数清零。
- 交替错误（429/network 各 2 次）不达分族阈值但触总上限 ×5；respond 消息的投影形状断言（deriveMessages 模型可见性）；L1 重试期不预烧 L2 计数（llm-retry 覆盖链序）；带工具 ran 流派发点在 tool/result 落账后（事件序断言）。

## 拆分与实施顺序（对抗审查 C 批序重排——原子交付）

1. **批 A**（内核接口 + 守门原子交付）：C1 决策集 + C2 窗口可达 + fatal code 透传 + **agent-continuation 的 hasTools 让位改动同批落地**（内核改道与插件守门必须原子——continuationKit 经 harness:113 默认装配，批 A 单独落地会让旧插件见 max-tokens+非空 content 即 resume，带工具行为从粘性 final 翻转为续写，中间态不可交付）。OUTPUT-TOKEN-CONTINUATION 验收清单/测试口径两处「结构保证」条目同步改写（带工具亦派发）；PLUGIN-AUTHORING agentTurnConclude 节迁移注记。
2. **批 B+C 合并**（llm 下放与消费端同批）：C4 rawReason 管道 + 处置序下放 + C7 显式码 + error-recovery + 文案插件（独立包 packages/truncation-messages——C 审查裁决：先例 = delegation rescue 文案住域包，agentTruncatedTool 窗口的域主即该插件，并入 agent-continuation 是错域）+ 装配三处（harness kit + apps/cli/build-world + apps/host-hub/worker/assembly——C 审查抓的第三装配点）+ C5 配置面。
3. **批 D**（收尾）：C6 词表收口 + formatArgsEcho 参数化 + 文档同步。

**迁移面声明（修正）**：无插件世界行为不变；**装配世界（主流形态）批 A 即行为翻转**（带工具 max-tokens：粘性 final → agent-continuation hasTools 判断后仍不续）——新行为回归用例钉死，非「无迁移面」。
