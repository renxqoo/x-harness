# BATCH2 方案——四项挂账功能（prompt images / 工具输出增量流 / 子代理实时事件面 / 会话删除）

状态机：**定稿候选**（草稿 → **[当前]** 对抗审查已处置 → 定稿 → 已实施 → 已核销）。本批 =
MIGRATION §6 四项挂账的统一实施方案，契约基线 = DESIGN.md（已核销态）；实施时 DESIGN.md
各节随代码同变（方案与代码同变纪律）。

审查记录：定稿前两路并行对抗审查（契约/语义面 6H/7M/5L；并发/资源生命周期面 3H/6M/5L），
全部处置见 §8；其中 4 条审查发现指向**既有缺陷**（inbox 逐块分目、413 防线盲区、partial
双计、kick 失败占槽泄漏），本批一并修复。

## 0. 分级与总量

| 项 | 级 | 判据 |
| --- | --- | --- |
| F1 prompt images | 中 | 跨 6 内核包 + hub 协议放开；ContentBlock 判别联合加成员（外部契约变形） |
| F2 工具输出增量流 | 中 | 内核 dispatch/exec 契约加可选通道 + 新事件 token + hub 桥接 |
| F3 子代理实时事件面 | 中 | delegation 新事件面 + bridge 归属重构（修 3 个既有污染/双计缺陷） |
| F4 会话删除命令 | 中 | hub 协议加命令（封闭集 55→56）+ 目录删除安全面 |

无不可逆存量数据变更。四件各自独立成波，每波独立提交、四门全绿。

---

## 1. F1 prompt images（内核 ContentBlock 加 image 块）

### 1.1 外部契约

- `ContentBlock` 判别联合加成员：
  `{ readonly type: "image"; readonly data: string; readonly mediaType: string }`
  （data = 纯 base64 载荷，无 `data:` 前缀；mediaType = MIME 如 `image/png`。字段名对齐 hub
  WireImage——hub wire 零换名；pi 映射层换名 `mimeType`。）
- **image 块仅 user 域合法**：`user/message` 事件与 `agent/inbox/spliced` insert 的 content
  放行；`assistant/message`、`assistant/attempt` 的 content **拒**（gates 按事件类型区分——
  驱动永不铸 assistant image，损坏档案在恢复面 fail-closed，映射层无需处理）。
- Agent face：`followup(text, options?: { images?: readonly ImageBlock[] })`、
  `steer(text, options?: { images?: readonly ImageBlock[] })`；`inject` 保持纯文本
  （通知注入通道单一用途——裁决 R7）。
- **投递形状（单 entry 全块）**：followup/steer 携图必须落**单条 inbox entry、content 全块
  数组**，claim 时作为**单条 user/message** 消费。现状 `insertData`（inbox.ts:43）逐块分目、
  `claimTurnBatch`（inbox.ts:49）next-turn 只领队首——不改则图文拆轮。修法：`insertData`
  改为**每次 splice 一条 entry**（`entries: [{ id, content: contents }]`）——既有调用方全部
  是单 text 块，行为等价零迁移；图文由此同 entry 同轮。实施时 grep `insertData` 全部调用方
  核实无依赖逐块粒度者（repair 回灌面重点）。
- insert content 块序：`[{type:"text",text}, ...images]`——text 块恒在（空串 text 由映射层
  过滤，WAL 形状稳定）；纯图 prompt（message=""）由此支持。
- hub 协议：`prompt/steer/follow_up` 的 images 字段从「恒拒」放开为承载；`/compact` 拦截
  携图**继续拒**（不变）。
- 量限（hub 边缘执法，limits.ts 常量）：单图 base64 ≤ `PROMPT_IMAGE_DATA_MAX`（5 MiB）、
  张数 ≤ `PROMPT_IMAGES_MAX`（8）、**总量 ≤ `PROMPT_IMAGES_TOTAL_MAX`（12 MiB）**——三条
  共存（12 MiB 总量是 16 MiB 行限内的诚实上限，单条/张数上限独立有效）；错误串
  `invalid images: image too large` / `invalid images: too many images` /
  `invalid images: images too large in total`。
- **模型能力门（执法点 = worker 命令层）**：providers.json 模型条目加可选
  `input?: ("text"|"image")[]`（缺省 `["text"]`）。传递链（审 H3 处置——快照处原方案断链，
  现按 modelMeta 通道走通）：providers.json → `buildAssemblySnapshot` 的 modelMeta 扩
  `input` 字段（catalog.ts:147-165 现把模型降为纯字符串数组——modelMeta 是唯一 per-model
  元数据过河通道，host.ts:89-90 构造处同步扩）→ HUB_WORKER_PROVIDERS → worker-catalog.ts
  的 modelMeta 同形扩展 → prompt 族三命令校验：images 在场而当前模型（dial 折叠解析单点）
  input 不含 `"image"` → failure `invalid images: model does not accept images`。
  pi-adapter 侧 `Model.input` **按请求查表如实反映**（adapter core 加 `inputByModel` 映射，
  assembly.ts buildAdapters 从同一 modelMeta 构造；缺省 `["text"]`）——pi-ai openai 路径在
  input 缺 image 时会把图**降级为占位文本**（transform-messages downgradeUnsupportedImages），
  adapter 如实申报防降级；anthropic 路径不消费 input（恒发图）——hub 门才是统一执法点。
  测试形态 scriptCatalog（worker-catalog.ts:64-70）modelMeta 补 `"script-1": { input:
  ["text","image"], reasoning: true }`（审 H4——否则 script 测试被门误拒）。
- 垃圾策略两套分野（落档）：hub wire 非数组/坏形状**硬拒**（协议边缘严格，images.ts 单点）；
  kernel face `options.images` 非数组**视同 undefined 降级**（进程内 API 容错）。不同层面
  不同纪律，非双轨。

### 1.2 内核改动面

| 文件 | 改动 |
| --- | --- |
| `packages/core/session/src/types.ts:31` | ContentBlock 加 image 成员；导出 `ImageBlock` 别名 |
| `packages/core/session/src/gates.ts:27` | `isContentBlocks` 加 image 分支（data/mediaType 均 isStr）；按事件域区分：assistant 域 content 拒 image |
| `packages/agent-loop/src/types.ts:34-38` | followup/steer 加 options.images |
| `packages/agent-loop/src/driver.ts:219-231` | followup/steer 铸块 `[{text}, ...images]` |
| `packages/agent-loop/src/inbox.ts:35-45` | **insertData 单 entry 化**（修审 H1：图文拆轮 + 既有逐块分目形状） |
| `packages/llm/src/pi-context.ts:71-79` | user case 逐块映射：text→TextContent（非空）、image→`ImageContent{data, mimeType: mediaType}`；整条空仍跳过 |
| `packages/llm/src/pi-adapter.ts:107-118` | Model `input` = `core.inputByModel?.[request.model] ?? ["text"]`（per-request 查表——审 H3：adapter 是 per-provider、模型 per-request 构造，查表在请求点） |
| `packages/compaction/src/estimate.ts:9-16` | estimateBlocks 加 image 分支：固定 `IMAGE_TOKENS = 2048`（视觉 API 下采样典型占用；高估=促折叠，安全侧），常量导出供 occupancy 复用 |
| `packages/compaction/src/occupancy.ts:109-128` | pendingClaimTokens 加 image 分支（IMAGE_TOKENS 同源）——修审 H2：413 防线对图盲 |
| `packages/compaction/src/serialize.ts:90-129` | userPart 对 image 块落占位串 `[image: <mediaType>]`（修审 M4：摘要输入完全丢图痕迹 = 静默降级） |

`snapshot.ts` 核实无需改动（谓词只认单 text 块信封，image 消息天然非快照节点）。
plugin-api 三助手是 text 过滤器，image 自动落 nonTextOf，无需改动。

### 1.3 hub 改动面

- `shared/images.ts`：normalizeImages 加三条量限（常量进 limits.ts）。
- `worker/worker-commands.ts`：parseImages 从「在场即拒」改为返回归一 images；prompt（含
  promptStreamingBranch）/steer/follow_up 传 `{ images }`；模型能力门（dial 折叠读口 +
  worker-catalog modelMeta 查询，单点 helper）。
- `shared/catalog-types.ts` + `catalog.ts` + `worker-catalog.ts`（+ `host.ts` snapshot 构造）+
  `presets.ts`：模型条目 `input` 可选字段全链透传；scriptCatalog 补 script-1 能力。
- `worker/worker-read-commands.ts`：**get_messages 软上限**——组装后超
  `WORKER_RESPONSE_SOFT_CAP`（100 MiB）→ failure `response too large; use get_entries`
  （审 M6 处置：否则多轮携图全量投影可击穿 128 MiB worker 行限，以 worker 被杀收场——
  有界失败优于进程死亡）；`get_fork_messages` 的行投影对 image 块落 `[image]` 标记（审 M6：
  纯图行现在整行缺席）。
- `shared/inbox-fold.ts`：queue 文本投影对 image 块追加 `[image]` 标记（纯图 entry 现在得
  空串不可见）。
- 持久化：base64 全量内联 events.jsonl（**裁决 R1：不加 sidecar**——档案自包含是单一真相，
  sidecar 造双轨）。

### 1.4 已知边界与不处理

- 工具结果带图（pi ToolResultMessage 支持 ImageContent，但内核 ToolOutcome 是 `content:
  string` 单串）——工具面加块是另一契约，挂账不偷改。
- assistant/tool 域 image——按非法形状拒（恢复面 fail-closed）。
- real LLM 门 vision 旅程——无 vision 凭证保证，pi-context 单测覆盖映射即止。
- 已知边界（如实落 DESIGN）：①get_messages 全量含图（软上限兜底）；②恢复全内存驻留，
  多轮携图上界 = 量限 × 轮数；③64 MiB 直读上限（DIRECT_READ_MAX_BYTES）：thread/register
  超限拒 `Session file not readable`、list_saved 超限跳过该会话（既有降级面，携图会话更易
  触达——审 M5 声明）；④compaction 折叠摘要以占位串标记图（不回传原图——摘要语义使然）。

---

## 2. F2 工具输出增量流面（get_inflight toolOutputs 实时部分输出）

### 2.1 外部契约

- `ToolCallRequest` / `ToolExecContext` 加可选 `onOutput?: (delta: string) => void`：
  执行中可多次调用的增量通道；纯观察面（不进 WAL、不影响结果）；结果权威仍 = 返回值
  ToolOutcome（「结果即返回值」不变量不动）。中间件可换 onOutput（与 signal 同类——包裹
  /过滤合法；args/name/callId/session 仍冻结）。
- **onOutput 抛错契约（审 M3 处置）**：实现方自负不抛（与事件监听器同纪律）；双层防御——
  agent-loop 调度器传出的 onOutput 自包裹 try/catch 静默（观察面异常不杀工具结果）；
  tool-bash 的 collector 回调点防御性包裹（观察者 throw 不得杀死 pump——pump 死则 reader
  不 cancel、子进程阻塞满管道直到墙钟超时）。
- 新事件 token `agentToolStream`（名 "agent/tool-stream"）：payload
  `{ session: SessionId; callId: string; delta: string }`，agentScope 发射、freeze:none
  （realtime-only，不落 WAL；defineEvent 显式声明——与 agentAssistantStream 同款）。agent-loop
  driver deps 加 `emitToolStream(callId, delta)`。
- hub wire 帧 `agent/tool-stream`：payload = 事件 payload 原样（`{session, callId, delta}`，
  桥惯例逐字转发——审 L2 处置）。get_inflight 契约更新：toolOutputs = 执行中实时尾部
  （既有不变量：尾部 64 KiB/调用、至多 8 条、truncated 粘滞）；无增量工具（一次性结果）
  执行期为空串占位——如实，非缺陷。
- **帧节流（审 M1 处置）**：桥对 tool-stream 帧 per-callId 尾沿合并——emit 间隔 ≥25 ms，
  间隔内的 delta 连接合并（delta 语义可加，连接无损），settle 时冲刷尾批。火喉输出
  （`yes`/大构建日志）下 wire 帧率有界；inflight 逐 delta 追加不受节流（get_inflight 恒新鲜）。
- **两口径声明**：delta 流 = 原始字节流口径（ANSI 清洗是结算时态——escape 序列可跨 chunk，
  逐块清洗会截坏序列，不做）；tool/result = 清洗后结算口径。消费方须知两口径差异（审
  M2/L4 处置）。

### 2.2 改动面

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 内核 tools | `packages/core/tools/src/types.ts` | 两接口加 onOutput |
| 内核 tools | `packages/core/tools/src/dispatch.ts:100-115` | runBody 透传 onOutput（缺省不伪造字段——与 session 同款条件展开） |
| 内核 loop | `packages/agent-loop/src/tokens.ts` | agentToolStream token（freeze:none 显式） |
| 内核 loop | `packages/agent-loop/src/tool-calls.ts:19-29,119,141` | SchedulerDeps 加 emitToolStream；池/排他两处 dispatch 传 `onOutput`（自包裹 try/catch） |
| 内核 loop | `packages/agent-loop/src/step.ts:447-461` | scheduleTools 内联构造 SchedulerDeps——emitToolStream 必经此传参（审 M3 补） |
| 内核 loop | `packages/agent-loop/src/plugin.ts:68-98` | driver deps 接线：agentScope.emit(agentToolStream, {session, callId, delta}) |
| 内核 bash | `packages/tool-bash/src/collect.ts` + `bash.ts` | ChannelCollector 构造加 `onChunk?`，push() **在 fullCap 早退之前**回调（过帽仍流——对齐直执行面 truncated 语义），回调点 try/catch 防御；bash.execute 把 ctx.onOutput 接进去（stdout/stderr 双流均喂） |
| hub | `worker/event-bridge.ts` | 订阅 agentToolStream：主会话 → inflight.toolOutput(callId, delta) + 节流后 emit 帧；子会话 → W2 期不外发（W3 归属泛化后带 session 转发——审 L5：无中间怪形）。既有 tool/call 空占位保留（startedAt + 基线），tool/result → toolDone 不变 |

内存/量级预算：InflightState 既有 64 KiB×8 封顶——增量追加保尾截断，上界不变；追加成本 =
每 delta 一次 O(64 KiB) 字符串拷贝（火喉 ~1k chunk/s ≈ 64 MB/s memcpy 量级，可承受）；
wire 帧经 25 ms 节流有界。**既有面挂账**：worker stdout writer 是无界串行 promise 链
（stdout-guard.ts:82-91），慢 host + 高频帧下待写闭包无界堆积——bash_execution_update 与
llm/chunk 已在此风险面上，本批不扩大（新面已节流）但登记 MIGRATION §6 挂账（背压/有界
队列，独立收敛）。

### 2.3 不处理

- 直执行面（bash-exec.ts）已有 `bash_execution_update`——通道并存不合并（模型工具路径 vs
  宿主直执行路径，语义不同源）。
- 后台任务面 read（tasks.ts 字节偏移拉模型）——task 域既有面，不动。

---

## 3. F3 子代理实时事件面（去轮询，改推送）

### 3.1 现状与缺陷（探查实证）

「轮询」实体 = 客户端拉模型 `get_subagents`（仓库内**无任何 delegation 定时器**——mailbox
drain 300ms 在 hub 形态未装配不激活）。通知注入 = notifier 监听 agentStatus → idle 边沿 →
铸 `[agent-notification]` 文本 steer 进父收件箱（父模型面）。**三个既有缺陷**（本波修复）：

- D1 子会话 WAL 事件混入主线程流：event-bridge `onSessionEvent` 丢弃 payload 的 session
  字段，子的 turn/start/assistant 等事件**翻转主线程 streaming/inflight 状态**（污染）。
- D2 llmTurn/llmStep 全局跟踪被子帧无条件覆盖（event-bridge.ts:115-123）+ llm/chunk tap
  不分会话 feedPartial（:181-193）+ **agentAssistantStream 处理器自身也不分会话喂 partial**
  （审 H6 补）——子模型流污染主线程 partial 伪消息。
- D3 **partial 双计**（审 M4 发现）：主会话的 text/thinking 同时经 agentAssistantStream
  处理器（:118-121）与 tapLlmStream feedPartial（:185-188）两路推进 partial——现状
  get_inflight 伪消息正文就是双份。

另：frames.ts 的 `agentName?` 字段 DESIGN §4 声称「仅子代理域事件携带」但从未填——死字段。

### 3.2 外部契约

**内核 agent-delegation 新增两个 realtime 事件 token（freeze:none，不进 WAL）：**

- `agentSpawned`（"agent/spawned"）：`{ parent, agentId, sessionId, type, depth }`——
  **两个发射点**：①spawn 成功、lineage 登记后；②**revive 复活注册时**（revive.ts:35-63 现
  不发任何事件——审 H2/M1/M2：复活子出现在快照但无推送、桥映射缺行、两源不一致）。
- `agentFinished`（"agent/finished"）：`{ parent, agentId, sessionId, outcome, detail,
  summary? }`——outcome ∈ `"completed" | "stopped" | "failed"`（completed 映射 completed；
  aborted → stopped；error/interrupted/max-tokens/blocked → failed）；detail =
  failureDetail（词表单一真相复用）；summary ≤200 字符透传。
- **finished 语义 = 每运行周期恰一次，非生命周期终态**（审 H5c/R2 处置）：stop 后可再
  message 复活（verbs.ts:149-161），复活→再运行→idle 会再发 finished——消费方以
  get_subagents 快照对账终态，finished 是周期边沿事件。
- 发射点收敛（审 H5b 处置——**门拒/建会失败不发事件**：无 agentId/sessionId 可填，且工具
  错误结果已是同步反馈，客户端从未见过 spawned，发孤儿事件无法关联）：
  ① deliver()（正常完成 / stopAll 级联 / 孤儿收养——armed-idle 单点，armed 复位在同步段
  无双发）；② spawn kick 失败路径（spawn.ts:126-129 followup throw——spawned 已发，必须
  闭环 finished{failed} 并**释放占槽** occupied=false——审 H3：该路径现为永久泄漏 + 幽灵）；
  ③ stop verb 对**已 idle 子**同步发射（无 armed-idle 边沿可达——审 L4）；④ thread/stop /
  fork / clone 拆除路径（见下）。
- **拆除序统一**（审 H5a 处置）：thread-commands 的 stop/fork/clone 现为「先
  bridge.unsubscribe() 再 teardownWorld」——tearingDown 门挡回 notifier，子无 finished。
  统一为「先 delegationView.stopAll（桥在线，finished 可达）→ unsubscribe → teardownWorld」
  （对齐 worker 优雅关停既有序，worker.ts:143-152）。

**hub wire 帧（DESIGN §4 词表加列）：**

- `agent/spawned`、`agent/finished`（payload 原样 + threadId 盖章 = 父线程）。
- session 域帧 payload 统一加 `session` 字段（`{seq, time, ...data, session}`——置于 data
  展开后，防同名遮蔽；SessionEventData 词表无 session 键，核实安全）。子会话 WAL 帧**外发
  但不喂主线程状态**（修 D1）；客户端以 `payload.session !== threadId` 过滤归属。
- `agentName` 激活：bridge 维护 session→{agentId, type} 映射，**agentSpawned 事件喂（含
  revive 重播种——修 M1）**；清理面 = unsubscribe 全清 + sessionDisposed 逐行清（对齐
  childStatuses 先例，修 M5 无界增长）；fork 重键 = wire 重接时映射空置重建（新装配无子）。
  子归属帧填 agentName。
- llm/chunk 仅主会话流外发 + tap 按 request.session 过滤 feedPartial（修 D2 第二路）；
  **agentAssistantStream 处理器仅主会话喂 partial / llmTurn / llmStep**（修 D2 第一路）；
  **partial 的 text/thinking 唯一源 = agentAssistantStream 帧，tap 只喂 tool-call-delta**
  （修 D3 双计——stream 帧与 tap 对同一 chunk 双路推进是现状 bug）。LlmRequest 加可选
  `session?: SessionId`（step.ts:356-365 单点构造处携带；pi-adapter 不透传出站）。子的
  模型增量经 `agent/assistant-stream`（payload 已含 session）外发——不双通道重复（R4）。
- 消费模型（去轮询的兑现）：客户端水化一次 `get_subagents` 快照 + 订阅
  `agent/spawned`/`agent/status`/`agent/finished` 增量——状态变化有推送，零轮询。
  get_subagents 保留为水化快照读（OBSERVER 成员资格不变）；DESIGN §3.8 改写。通知注入
  **保留**（父模型感知通道，不同消费方，非轮询——R3）。

### 3.3 改动面

| 文件 | 改动 |
| --- | --- |
| `packages/agent-delegation/src/tokens.ts`（新） | agentSpawned/agentFinished 定义 + 导出 |
| `packages/agent-delegation/src/spawn.ts` | 成功路径 emit spawned；kick 失败 emit finished{failed} + 释放占槽 |
| `packages/agent-delegation/src/revive.ts` | 复活注册 emit spawned（重播种） |
| `packages/agent-delegation/src/notify.ts` | deliver() 统一 emit finished（正常 + 孤儿分支）；NotifyDeps 加 emitFinished |
| `packages/agent-delegation/src/verbs.ts` | stop 对 idle 子同步 emit finished{stopped} |
| `packages/agent-delegation/src/plugin.ts` | 接线 emit（ctx.emit 于 root 层） |
| `packages/agent-loop/src/step.ts:356-365` + `packages/llm/src/types.ts` | LlmRequest 加 session?（构造单点——审 L1 修正：仅一处） |
| `apps/host-hub/src/worker/thread-commands.ts` | stop/fork/clone 拆除序统一（stopAll 先于 unsubscribe） |
| `apps/host-hub/src/worker/event-bridge.ts` | D1/D2/D3 修复 + agentName 映射（含清理面）+ spawned/finished 转发 + F2 tool-stream 归属泛化 |

### 3.4 不处理

- mailbox 跨进程 drain（300ms 自链 setTimeout）——hub 不装配该面不激活；跨进程部署既有面
  另域。
- 子代理 message 投递事件（agentMessaged 类）——最小封闭集裁决：spawned/finished 是状态
  面承重事件，message 已有 inbox 语义可观测。

---

## 4. F4 会话删除命令（thread/delete）

### 4.1 外部契约

- `thread/delete {sessionPath}` → success `{}`。**幂等**：目录已不在 = success（对齐
  thread/stop「未知 success」先例）。host 本地命令（不进池、worker 无感知、四集合不动）。
  输入键用 sessionPath（对齐 resume/register——作用于存档的命令族；stop/retire 用 threadId
  是活线程操作族——分野落 DESIGN 附录，审 L5）。
- 语义序（同步段先行，**表操作与 rename 发起之间零 await**）：
  1. shapeFence（词法 + canonical 归一，host-commands.ts:55 复用）+ realpath 围栏
    （read-history.ts fenceSessionPath 复用，拒 symlink 逃逸）。
  2. 占用表查 holder：live/spawning/retiring 持有 → failure **`already open`**（既有占用
    文案复用，词表收敛——审 L3；显式两步：先 thread/stop，不自动停，R5）；parked/dead
    持有 → table.remove(holder)（内含 occupiedPaths 撤销）。
  3. **原子消失：`rename(sessionsRoot/<id>, agentDir/trash/<id>.<pid>.<rand>)`**（审 M8/L3
    处置）——rename 原子，成功即从 sessionsRoot 消失，一切后续 stat/lock/register 干净
    失败；TOCTOU 窗口缩窄到 rename 瞬时。
  4. 子代理会话拒删：**lock 探活先行**（读 `lock` 纯 pid + `process.kill(pid, 0)` 探活——
    活 → failure `session is locked by another process`；死 pid/读失败 → 继续），后查
    header.json 带 `agentId` → failure `cannot delete subagent session`（lock 先于 header
    的写序在实施期核实——lock 探活同时覆盖「子会话创建中 header 未落」窗口，审 L2）。
    无 header 的孤儿目录（半创建残迹）仍删。
  5. rename 后异步 `rm(trash 目标, {recursive, force})`（trash 残迹由 tmp-sweep 扩清——
    mtime > 1h，复用既有先例；rm 中途崩溃不污染 sessionsRoot）。
- 命令封闭集 55→56：COMMAND_NAMES + smoke 锚 + 全量矩阵 + get_commands 自动反映。
- 错误词表新增：`cannot delete subagent session` / `session is locked by another process`
  （`already open` 与 shapeFence 串复用）。

### 4.2 并发/一致性预算（审 H1/M7/M8/L3 处置后的完整矩阵）

- **host 显式 resume 穿窗路径**（审 H1 指出方案初稿盲区）：撤表→rename 微窗内到达的
  thread/resume 可占位并通过 stat → spawn worker → worker 侧 resume 预检（存在性 stat，
  thread-commands.ts:356-362）在 rename 后失败 → host 重试 12 次 → dead → `Unknown
  threadId`——**有界失败链，不产生写丢失**。极窄残余窗（archive 全量读完成于 rename 前）：
  worker 在已改名目录上运行至 idle-retire 收敛——如实落档，量级 = 微秒窗 × 全量读耗时，
  工程上不可达稳态。
- 并发双 delete 同 path：表 remove 幂等 + rename ENOENT 容忍（rename 失败回读目标不存在 →
  success 幂等）→ 双 success，无 double-failure。
- rm 中途崩溃：trash 内残迹，sweep 回收；sessionsRoot 无半删目录（rename 原子性）。
- 跨 host 并发删除同一会话：lock 探活是 best-effort 防线（check-then-act 缩窄至 rename
  瞬时）——**跨 host 并发删除不在支持矩阵**，落 DESIGN 已知边界。
- bash spill（agentDir/bash-outputs）不随会话删——tmp-sweep 7 天兜底（既有语义）。
- wake fail-open 复活（读命令触发）：同 resume 穿窗分析——stat 面失败，有界收敛。

### 4.3 改动面

`protocol/commands.ts`（+1 名）、`host/host-commands.ts`（注册）、`host/session-delete.ts`
（新文件——一动词一文件）、`host/tmp-sweep.ts`（trash 扩清）、DESIGN §3.10 重写 + 附录
A/B、MIGRATION §6 销账。

---

## 5. 实施顺序（波次）

1. **W1 = F1**：内核 image 链（session → agent-loop inbox/driver → llm → compaction
   estimate/occupancy/serialize）→ hub 放开 + 量限 + 能力门（含 scriptCatalog）。四门 + 提交。
2. **W2 = F2**：内核 onOutput 链（tools → agent-loop tokens/tool-calls/step/plugin →
   tool-bash）→ hub 桥接（节流 + 主会话过滤）。四门 + 提交。
3. **W3 = F3**：delegation 事件（spawn/revive/notify/verbs/plugin）+ LlmRequest.session +
   bridge 归属重构（D1/D2/D3 回归用例）+ 拆除序统一 + tool-stream 归属泛化。四门 + 提交。
4. **W4 = F4**：thread/delete（trash 原子化 + 状态矩阵）。四门 + 提交。
5. **W5 收口**：对抗审查（≥2 并行：契约/语义面 + 并发/资源生命周期面）→ 处置 → 假绿对抗
   抽查 → 文档核销（DESIGN/MIGRATION 同变 + 本文档状态推进）。

## 6. 测试口径（先行）

- **F1**：gates 表驱动（user 域 image 过 / assistant 域拒 / 坏形状拒 / 恢复面含图卷可重开 /
  坏 assistant 图卷恢复拒）；**inbox 单 entry 断言**（图文同 entry 同轮消费——审 H1 回归）；
  driver followup images → insert content 块序；pi-context user image →
  ImageContent{mimeType} 换名映射；estimate/occupancy image 分支（413 防线计图——审 H2
  回归）；serialize 占位标记；hub prompt 携图全链（script adapter 断言 WAL 落单 entry 图
  文块）+ 三条量限拒 + 模型能力拒（含 scriptCatalog 放行对照）+ compact 拒图回归；
  get_messages 软上限；get_fork_messages/inbox-fold 图标记。
- **F2**：dispatch onOutput 透传（含中间件换 onOutput 合法性）；onOutput throw 双层防御
  （调度器包裹不杀结果 / collector 包裹不杀 pump——审 M3 回归）；bash collector onChunk
  逐块 + 过 fullCap 仍流；agentToolStream 发射（池/排他/abort 未启动不发射）；桥主会话喂
  inflight + 节流合并断言（25 ms 窗内 delta 连接）；get_inflight 执行中非空（embedded
  worker 真跑 bash 工具，帧收集法断言）。
- **F3**：spawned/finished 发射矩阵表驱动（正常完成 / stopAll 级联 / **stop idle 子同步**
  / kick 失败闭环+释放占槽 / 孤儿收养 / **revive 重播种**）；**每运行周期恰一次**（复活后
  再 finished）；拆除序（thread/stop 时 finished 帧可达——审 H5a 回归）；D1 回归（子
  turn/start 不翻转主 streaming/inflight）；D2 回归（子模型流不污染主 partial、llm/chunk
  不外发子流、llmTurn/llmStep 不被覆盖）；**D3 回归（主会话 partial 正文不双计——审 M4
  回归）**；agentName 填充（含 revive）；session 域帧带 session 字段；get_subagents 快照
  语义不变；fork 重键映射清空重建。
- **F4**：状态矩阵表驱动（live 拒 already open / parked 删 / dead 删 / 无表项删 / 已删幂等 /
  子代理拒 / 活锁拒 / 死锁过 / symlink 逃逸拒 / 形状拒 / 无 header 孤儿目录删）；穿窗
  resume 收敛回归（delete 后 resume → 有界失败链终态 Unknown threadId）；双 delete 幂等；
  trash 清扫；56 命令锚。
- 覆盖率：四门阈值不动（行/语句/函数 ≥90、分支 ≥85），只升不降。

## 7. 方向性裁决汇总（默认裁决，否决窗口开放）

| # | 裁决 | 理由 |
| --- | --- | --- |
| R1 | 图内联 WAL，不加 sidecar | 档案自包含 = 单一真相；sidecar 造双轨（文件 + 引用） |
| R2 | image 仅 user 域合法（gates 按事件域执法） | 驱动永不铸 assistant image；损坏档案恢复面 fail-closed |
| R3 | 通知注入保留 | 父模型感知通道 ≠ 客户端轮询；不同消费方 |
| R4 | llm/chunk 仅主会话，子流走 assistant-stream | 不双通道重复；payload 已含 session |
| R5 | 删除 = 显式两步（stop 后 delete），不自动停 | 拆除补偿复杂度；幂等两步语义清晰 |
| R6 | 量限/能力门在 hub 边缘，内核不截断用户内容 | 内核是形状层不是策略层；与 15 MiB 纯文本同口径 |
| R7 | inject 保持纯文本 | 通知注入通道单一用途；能力按消费面加 |
| R8 | insertData 单 entry 化（不另铸块形态入口） | 既有调用方全单块零迁移；图文同轮是唯一正确形状 |
| R9 | tool-stream 桥 25 ms 尾沿合并节流 | wire 帧率有界；inflight 恒新鲜；delta 可连接无损 |
| R10 | 删除原子化 = rename-to-trash + sweep | rename 原子消失收敛一切 TOCTOU/残迹面；复用 sweep 先例 |
| R11 | finished = 每运行周期恰一次（非生命周期终态） | 复活语义下「终态」不存在；快照对账 + 边沿事件分层 |
| R12 | 门拒/建会失败不发 finished | 无身份可填、无法关联；工具错误已是同步反馈 |

## 8. 审查处置记录（定稿前两路并行对抗审查）

**契约/语义面（6H/7M/5L）**：H1 inbox 逐块分目→§1.1 单 entry 化 + R8 + 测试回归；H2
occupancy 413 盲区→§1.2 表补行；H3 能力链快照断链/per-model 粒度→§1.1 modelMeta 通道 +
inputByModel 按请求查表；H4 scriptCatalog 门误拒→§1.1 补；H5 恰一次反例（拆除序/门拒/
复活再发）→§3.2 发射点收敛 + R11/R12 + 拆除序统一；H6 D2 第三路→§3.1 D2 补全。M1/M2
revive 映射断链→spawned-on-revive；M3 step.ts 缺席→§2.2 表补行；M4 摘要丢图→serialize
占位；M5 64MiB 降级→§1.4 边界③；M6 fork/queue 投影→图标记 + get_messages 软上限；M7/M8
删除竞态/TOCTOU→§4.2 矩阵 + R10。L1-L5→垃圾策略分野（§1.1）/帧 payload 原样（§2.1）/
`already open` 收敛（§4.1）/两口径声明（§2.1）/输入键分野落档（§4.1）。

**并发/资源生命周期面（3H/6M/5L）**：H1 host 显式 resume 穿窗→§4.2 完整收敛分析（零
await 间隔 + rename 原子化）；H2 revive 无事件→同契约面 M1 处置；H3 kick 失败幽灵+占槽
泄漏→§3.2 发射点② + 修既有泄漏。M1 writer 无界→§2.2 节流 + 挂账登记；M2 onChunk 位置/
两口径→§2.1/§2.2 定义；M3 onOutput throw→§2.1 契约 + 双层防御；M4 partial 双计→§3.1
D3 + 唯一源裁决；M5 映射清理→§3.2 清理面；M6 量限矛盾/128MiB 溢出→§1.1 总量 12 MiB +
get_messages 软上限。L1-L5→同契约面 L1/L2 处置、L2 子创建窗→lock 探活先行（§4.1.4）、
L3 残迹→trash、L4 stop idle 子→发射点③、L5 过渡形态→W2 仅主会话（§2.2）。
