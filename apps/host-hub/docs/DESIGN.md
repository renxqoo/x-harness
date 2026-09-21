# host-hub 设计基线（DESIGN）

> 状态：已核销（两轮并行方案审查 6H/26M/22L + 收口代码审查 3H/7M/10L + 5H/8M/7L + 假绿抽查处置全清；MIGRATION §8 全勾）
> 状态流转：草稿 → 定稿 → 实施中 → 已核销（验收清单全勾）
> 迁移源：/Users/wrr/work/my-agent/packages/host-hub（已核销实现，行为规格基线）｜底座：@x-harness/* 内核包族
> 文档族：[IMPLEMENTATION.md](IMPLEMENTATION.md)｜[MIGRATION.md](MIGRATION.md)

## 0. 定位与形态

host-hub 是 **x-harness 的多会话宿主**：一个 host 进程统一对外（JSONL over stdio），
每个活跃会话一个 worker 子进程（内裹一个 `createAgentWorld` + `loop.create/resume`
单会话世界）。App、web 桥、本地 CLI 客户端 spawn 它、喂命令、渲染事件帧。

```
 客户端（app/web/cli）            host-hub host（1 进程）             worker（每活跃会话 1 个）
 ┌────────────┐  stdin (JSONL)  ┌──────────────────────┐  管道 (JSONL)  ┌────────────────────┐
 │ 窗口/渲染    │ ─────────────► │ 命令路由/恰一对账      │ ─────────────► │ createAgentWorld    │
 │ 弹窗/恢复    │ ◄───────────── │ 会话占用表/模型目录    │ ◄───────────── │ loop.create/resume  │
 └────────────┘  stdout (JSONL) │ worker 生杀收编唤醒    │  事件/心跳      │ jsonl 持久会话       │
                 response/event/ └──────────────────────┘                └────────────────────┘
                 heartbeat/...
```

**【裁决·D1】进程模型 = host + 每会话一 worker 子进程**（迁移源同构）。进程是 OS
最硬隔离边界；`thread_died` + 自动复活 + 闲置收编整套可靠性机器继承。代价：每活跃
会话约 +100MB 常驻、spawn 冷启动一拍。

**【裁决·D2】直执行 bash 迁移**：输出流式回客户端；结果以 **user/message 信封**
append 进会话（进模型上下文投影，下次 prompt 生效）；执行前经 **ui_request confirm
弹窗**；**per-command AbortController 墙钟超时**。

**【裁决·D3】对外事件词表 = x-harness 内核词表**（session 事件 17+1 条 + bus 事件
token 名）+ worker 合成域（§4）；无翻译层。

**【裁决·D4】目录与命名对齐 x-harness 习惯**：agentDir = env `HUB_AGENT_DIR`
（缺省 `~/.x-harness/hub`）；项目数据目录 = `<cwd>/.x-harness`；kernel env 习惯
（`X_HARNESS_*`）归内核包，hub 旋钮恒 `HUB_*`。

## 1. 进程与启动约定

```js
spawn("<host-hub bin>", [], { env: { ...process.env, HUB_AGENT_DIR: <配置目录> } });
```

- stdin/stdout JSONL；stderr 是日志（worker 日志带 `[hub:worker:<threadId>]` 前缀转发）。
- 生命周期：stdin EOF / SIGTERM / SIGINT → host 优雅停全部 worker（dispose 会话、
  flush 落盘）→ flush 帧 → exit 0；shutdown 重入安全跑完一次。**关闭期在飞命令不补
  响应、不发死亡帧**；关闭期新到命令回 failure `shutting down`。
- 心跳：stdout 每秒一帧 `{type:"heartbeat", rssBytes, cpuPercent}`；**>10s 无心跳 =
  host 卡死**，客户端杀 host → 重启 → 按自己注册表逐个 `thread/resume`。
- worker 经同一可执行文件 `--internal-worker` 自 spawn（bun 三形态自解：argv[1]
  存在 / 编译产物 `/$bunfs/` 探测）；`HUB_WORKER_DISPATCHED=1` 哨兵防产物形态双重执行。
- 环境旋钮（坏值降级缺省；`get_host_info.limits` 回读）：`HUB_MAX_THREADS`（32）、
  `HUB_IDLE_RETIRE_MS`（900000）、`HUB_WORKER_STALE_MS`（30000）、
  `HUB_WORKER_EXIT_TIMEOUT_MS`（10000）、`HUB_RSS_RETIRE_BYTES`（0=关，下限 256MiB）、
  `HUB_BASH_TIMEOUT_MS`（600000，0=关——缺省值单点定义于 limits.ts，禁双硬编码）。
- agentDir 首跑自动创建目录结构（`sessions/`、`bash-outputs/`），零配置可启动。
- 死线常量：hello 截止 `WORKER_SPAWN_TIMEOUT_MS`（10s）；internal resume 每次尝试
  同死线；retiring 重评队列每线程上限 1024（满则丢行——排空中 worker 将死，帧不补）。

## 2. 协议基础

- 请求：一行一个 JSON，`type` 必填、`id` 可选（建议恒带）。
- **response 帧形状**：`{type:"response", id?, command, success, data? | error}`——
  `command` 恒为字符串（parse failure 时 `"parse"`）。**worker 全部响应（含
  shutting-down 拒绝/unknown command/parse failure）必须经单点 respond() 以
  id-first key 序发射**（host 中继按 `{"id":` 前缀识别响应帧——type-first 内联
  字面量会绕过对账核销，close 时补发第二响应破坏恰一）。
- **恰一响应铁律**：每个带 `id` 的命令恰好一个 response（id 回显）。唯一例外 =
  §1 关闭期在飞命令不补。覆盖全部终路：正常执行；worker 死亡（close 后对未见响应
  的 pending id 合成恰一 failure，已收不补）；spawn 失败/hello 不符（撤占用 + pending
  各补一 failure，不发 thread_died）；fork 重键在飞命令（旧 id 命令按旧 worker 域
  结算）；retiring 窗口命令（排队至 close 再重评）；shutting-down 窗口（failure）；
  worker 侧 unknown command / 单会话守卫拒绝（failure——worker 全部 failure 路径必须
  emit）；parse failure（无 id 可关联，单独回帧）；客户端 id 冒用 `@hub-internal:`
  前缀（恰一 failure）。
- 行上限：client→host 16 MiB、host→worker 16 MiB、worker→host 128 MiB；
  **host→client 不设上限**（本机可信，背压经串行写队列传导）。超限整行丢弃 +
  parse failure，不累积缓冲。LF 唯一分隔、容忍行尾 `\r`、空行忽略（自研分帧器，
  禁 Node readline）。
- 错误形态：`{"success":false,"error":"<英文中性>"}`；错误文案词表 = 封闭清单
  （附录 A）；单条命令失败绝不退出进程。

## 3. 命令集（56 个——迁移源 55 + thread/delete（BATCH2）；分组见各节）

| 组 | 命令 | host 本地/worker |
| --- | --- | --- |
| 线程生命周期 | thread/start、thread/resume、thread/register、thread/stop、thread/delete、thread/retire、thread/set_keepalive、thread/list、thread/list_saved | host |
| 对话驱动 | prompt、steer、follow_up、abort、clear_queue、compact | worker |
| 状态与历史 | get_state、get_inflight、get_messages、get_entries、get_tree、get_session_stats、set_session_name、get_commands、get_fork_messages | worker（§3.4 矩阵） |
| 收敛读口 | get_subagents、get_pending_dialogs | worker（非 live 空形态） |
| 会话树/分叉 | fork、clone | worker |
| 模型与目录 | get_models、set_model、set_model_override、models/add、models/remove | host（set_model 转发 worker） |
| 凭据 | auth/list、auth/set_api_key、auth/remove_key | host |
| 直执行 | bash、abort_bash | worker |
| 对话框 | ui_response | host 路由 |
| agents | agents/list、agents/create、agents/remove、subagent/steer | host / worker |
| skills | skills/list、skills/set_enabled、skills/remove | host |
| 设置 | settings/get、settings/set | host |
| 思考档 | set_thinking_level、get_thinking_level | worker |
| 权限 | permission/set_mode、permission/get_mode | host 单点注册（带 threadId 形态交池转发） |
| 宿主信息 | get_host_info、set_idle_retire_ms、set_rss_retire_bytes | host |
| 信任 | workspace/trust | host |

**observer 命令集（不重置 worker idle 计时）**：get_state、get_inflight、get_messages、
get_entries、get_tree、get_session_stats、get_commands、get_fork_messages、
get_subagents、get_pending_dialogs、get_thinking_level、permission/get_mode；host 本地
恒不涉（thread/list、thread/list_saved、get_models、get_host_info、agents/list、
skills/list、settings/get、permission/get_mode 无 threadId 形态、workspace/trust 无参
形态）。其余线程域命令均为写语义，重置 idle。

### 3.1 线程生命周期

- **thread/start** `{cwd?, provider?, modelId?, trusted?, permissionMode?, thinkingLevel?}` →
  `{threadId, cwd, sessionPath}`（+ 可选 `projectSettingsPresent:true`——仅 untrusted
  且项目设置文件存在时）。cwd 缺省 = host 进程 cwd。threadId = 会话 id（内核
  `isSafeSessionId` 词法，host 侧 `mintSessionId` 生成）；sessionPath =
  `<agentDir>/sessions/<id>/events.jsonl` 绝对路径。`trusted`（默认 false）决定
  project 级资源（skills/agent-types 目录 + 项目级设置）装载；fork/clone 继承源线程
  trusted。`trusted:true` 自动登记信任注册表（§3.9）。
- **thread/resume** `{sessionPath, cwd?, trusted?, permissionMode?, thinkingLevel?}` →
  同 start。sessionPath 必须绝对、落 `<agentDir>/sessions/` 之下（realpath 围栏防
  symlink 逃逸——register 与内部唤醒走同一围栏校验）。恢复语义（内核恢复器）：
  **末行截断（撕裂写）恢复完好前缀**；**中段坏行 fail-closed**（`cannot resume
  session: archive-corrupt...`——内核视为档案损坏宁可拒开，不静默截断；与迁移源
  「坏行丢弃保前缀」的差异为有意变更，MIGRATION §4）。**零字节/空 events.jsonl →
  hub 预检 failure `Session file not readable`**（内核对空卷返回成功——预检归 hub）。
  cwd 缺省序 = 会话 header.cwd > worker 现值。同路径占用 → failure `already open`。
  显式入参（permissionMode/thinkingLevel）覆盖 WAL 尾值落盘（不静默压制）。
- **thread/register** `{sessionPath, trusted?}` — 纳管为 parked 表项（host 本地、零
  worker）：同围栏校验；>64MiB 直读上限 → failure `Session file not readable`。
  裁决序：live 写者 → failure `already open`；同 id/同路径表项 → 幂等返回；否则建
  parked。
- **thread/stop** `{threadId}` — dispose + 删表项（会话保留）；幂等。
- **thread/retire** `{threadId}` — 收编 parked；幂等；未落盘 failure；唤醒在飞 →
  failure `thread not live`（客户端重发；重试耗尽落 dead 后幂等收编）；与 stop 竞争
  stop 优先。收编结算按 worker 域反查。
- **thread/set_keepalive** `{threadId, keepalive}` — 免闲置收编（不免 stale 杀/RSS）；
  不持久化；fork 不继承。
- **thread/list** → `[{threadId, cwd, sessionPath, state, idleMs, rssBytes, keepalive,
  isStreaming}]`——isStreaming 来自最近心跳（陈旧度 ≤1s，精确值 get_state）；非 live
  条目 idleMs=0、rssBytes=null。state：live / parked / dead。非 live 表项 1024 FIFO。
- **thread/list_saved** `{cwd?}` → `{sessions: SessionSummary[]}`。**查询键收窄为
  `{cwd?}`**（迁移源 model/forkParent/updatedAfter/updatedBefore/limit/cursor 退役——
  内核 header 无对应事实，全集过滤成本 O(全量读)；客户端全量拉后自滤——有意变更，
  MIGRATION §4）。SessionSummary = `{id, createdAt, updatedAt, title, model?, cwd?,
  forkParent?, messageCount, lastSeq}`——**排除子代理会话**（header.agentId 在场即
  滤除）；updatedAt = 尾事件 time（title 缺省派生自首条用户消息截断——继承源语义）；
  单会话 events.jsonl 超 64MiB → 跳过并 stderr 记（DIRECT_READ_MAX_BYTES 复用）；
  recency 序按 updatedAt。成本 O(会话数 × 全量 read)——诊断/恢复面命令，预算可受。

### 3.2 对话驱动

- **prompt** `{threadId, message, images?, streamingBehavior?}`。
  - images：user 域图像块 `{type:"image", data:base64, mediaType}`（BATCH2 起——内核
    ContentBlock 已加 image 块，仅 user 域合法）。形状校验 + 量限三条先行
    （`shared/images.ts` 单点）：张数 ≤8、单图 base64 ≤5MiB、总量 ≤12MiB（16MiB 行限内
    的诚实余量）；能力门：当前模型（dial 双源折叠）`input` 模态不含 `image` → failure
    `invalid images: model does not accept images`（防上游 openai 协议把图静默降级为
    占位文本）。投递形状 = **单 inbox entry 全块**（图文同 entry 同轮消费——内核
    insertData 单 entry 化）；纯图 prompt（message=""）合法。`/compact` 拦截携图仍拒。
  - 空闲态（无在飞 turn ∨ 无在飞 send）：`agent.followup(text, {images})`（受理即应答
    fire-and-accept）。斜杠命令分路（BATCH3 起——内核命令注册面
    `@x-harness/commands`）：prompt 先经 `commandRegistry.execute`——命中 → 成功
    respond `data` = 命令结果结构化载荷（compact 三元组；响应 command 字段留
    `prompt`、无 settled）；未注册词形（含 `/skill-name`）→ 按普通文本交模型
    （**与迁移源 settled unknown-command 面的差异有意变更**，MIGRATION §4）。
    `/compact` 由 compaction 包自声明（词法/执行/busy 全在内核单源）。
  - 流式中（turn 在飞 ∨ send 在飞——受理窗口同口径）：**必须带
    `streamingBehavior`**，`"steer"` → `agent.steer(text, {images})`、`"followUp"` →
    `agent.followup(text, {images})`。不带 → failure `streamingBehavior required while streaming`。
  - response 在受理时刻发出；收敛后 worker 发 `settled` 事件（§4 恰一不变式；
    **无 id 驱动命令不发 settled**）。
- **steer / follow_up** `{threadId, message, images?}` — 显式排队（agent.steer/followup，
  images 语义/量限/能力门与 prompt 同口径）；队列变化经 `agent/inbox/spliced` 事件可观察
  （文本读口 get_state.queue——`foldInbox` 投影，host/worker 共用折叠器；纯图 entry 投影为
  `[image: <mediaType>]` 标记）。
- **abort** `{threadId}` — `agent.cancel("client-abort")` + 停止在跑子代理任务
  （delegationView.stopAll）+ settle 挂起弹窗（默认拒绝）+ 中止手动压缩
  （compact AbortController 联动）+ 中止在跑直执行 bash（含弹窗期准入取消）。
- **clear_queue** `{threadId}` → `{steering:[], followUp:[]}` — 折叠当前队列后直接
  append `agent/inbox/spliced {op:"clear", reason:"client-clear"}` + flush（**不用
  agent.cancel**——那是 abort 语义；clear 事件是 driver 同款机制事件，折叠器天然
  清空）。
- **compact** `{threadId, customInstructions?}` — 薄壳（BATCH3 起）：合成 `/compact`
  行（customInstructions 有则拼）走与 prompt 拦截同一条内核 execute 路（单一执行路径
  ——busy 前置/skip 归一/成功三元组全在 compaction 包的 commandCompactPlugin）；响应
  形状不变。直调 `compactionRunner.compact({session,
  trigger:"manual", customInstructions?, signal})`；压缩中再发 → failure（命令级
  isCompacting 预检）；**响应在完成时返回** `{summary, replacedCount, summaryTokens}`
  （summary 经 `previousSummaryOf(session.surface())`；replacedCount = replacedNodes；
  summaryTokens 为内核原值——迁移源无此字段，有意加法）。skip reason 归一（封闭）：
  no-cut-point / summary-input-budget-exhausted / summary-empty → `context too small
  to compact`；summarize-failed / summary-truncated / llm-unavailable / replace-failed /
  session-unknown → `compaction failed: <reason>`；summarizer-unconfigured →
  `compaction summarizer not configured`；aborted → `compaction aborted`。中断用 abort。
- **`/compact` 拦截（hub 单源词法）**：trim 后行首、大小写敏感 `/compact`（后随空白
  分隔指示文本，trim 后为 customInstructions；空串视为未给）→ 等价 compact 命令时序
  （响应 command 留 `prompt`，完成才回）；携 images → failure；`/COMPACT` 大写 →
  conversation。

### 3.3 状态与历史

- **get_state** `{threadId}` → `{model, isStreaming, isCompacting, sessionId, sessionName,
  sessionFile, messageCount, queue}`。model = `{provider, model}` 形（**字段名
  model——迁移源为 modelId 单字段，改名声明 MIGRATION §4**）= `session/meta{dial}`
  尾值 → `request/header` 尾值 → 装配缺省；isCompacting 仅反映 worker 发起的手动
  压缩（自动压缩在 step 内部，经 `compaction/*` 事件可观察——声明性边界）；
  queue = `foldInbox(events)` 文本数组 `{steering:[], followUp:[]}`；isCompacting =
  命令执行中谓词（BATCH3 起数据源 = 桥对 command/run|done 的计数——本批唯一命令是
  compact，语义等价）。
- **get_inflight** `{threadId}` → `{turnStartSeq, turnStartedAt, message, toolOutputs,
  bash}`——turnStartSeq = 本轮 turn/start 事件 seq（轮边界唯一权威）；message = 在途
  assistant partial（`agent/assistant-stream` text/thinking chunk 累积 +
  `llm/chunk` 工具增量拼接，`assistant/message` 事件为步终局）；toolOutputs = 执行中
  实时尾部（BATCH2 起——模型工具增量经 `agent/tool-stream` 逐 delta 追加；尾部
  64KiB/调用、至多 8 条、truncated 粘滞；一次性结果工具执行期为空串占位——如实）；
  bash 按命令 id 隔离（读口取最新仍在跑者）。
  无在途 → `{null,null,null,[],null}` 恒 success。
- **get_messages** `{threadId}` — `session.deriveMessages()` 全量（无分页；仅诊断用）；
  软上限 100MiB（JSON 串长累计）——超限 failure `response too large; use get_entries`
  （多轮携图全量投影可超 128MiB worker 行限，有界失败优于 worker 被杀）；非 live 走
  §3.4 矩表。
- **get_entries** `{threadId, since?, before?, limit?}` → `{entries, leafSeq, hasMore}` —
  seq 游标（**seq = WAL 行号 = 数组下标，0 基**，会话内单调、跨重启/跨压缩恒稳定）。
  排他语义：`since` = 该 seq 之后（排他，等价 index+1 起前向）；`before` = 该 seq
  之前（排他，至 index-1 止后向）；`since` 越过 `before` 收敛空窗；limit 正整数
  ≤5000 取最近 N（缺省 = 全量）；hasMore 恒返回；entries =
  `[{seq, ts, event}]`（event = `{type, ...data}` 摊平形状；surfaceOp 随附）。
- **get_tree** `{threadId}` → `{ancestors, children, leafSeq}` — 会话 fork 谱系
  （hub 实现：ancestors 沿 header.parentSession 链**不含自身**；children =
  parentSession === id 的 headers，**排除子代理会话**（header.agentId 滤除）；
  leafSeq = events.length-1）。
- **get_session_stats** `{threadId}` → `{userMessages, assistantMessages, toolCalls,
  toolResults, tokens:{input,output,total,cost?}}` — WAL usage 折叠
  （assistant/message usage 字段防御性折叠）；**cost 在场即透传**（内核
  TokenUsage.cost 可选携带——比迁移源升级，目录 cost 表齐备后自动生效）。
- **set_session_name** `{threadId, name}` — `session/meta {key:"title"}` + flush；空串
  拒；响应无 data（受理即全部信息）。
- **get_commands** `{threadId}` → `[{name, description?, source: command|skill}]` —
  统一命令目录（BATCH3 起）：内核命令注册面 `commandRegistry.list()`（source:
  "command"——机器拦截的斜杠动词，`/compact` 由 compaction 包自声明，description
  `"Compact the conversation history"` 单点锚定）+ skills 清单（source:"skill"——
  模型分发面，未注册词形交模型）。**source 词表收缩 command|skill**
  （builtin→command，BATCH3 变更——命令注册面已下沉内核）。
- **get_fork_messages** `{threadId}` → `[{seq, text}]` — 可分叉用户消息（surface
  user/message 文本折叠）。

### 3.4 线程域命令 × 状态 全矩表

| 命令 | live | parked / dead | retiring | 缺/未知 threadId |
| --- | --- | --- | --- | --- |
| get_state、get_entries | worker | **直读**（免唤醒；不可用 fail-open 回落唤醒） | 排队至 close 重评 | failure |
| get_inflight、get_subagents、get_pending_dialogs | worker | **空形态**（恒 success） | 排队 | failure |
| 其余全部线程域命令 | worker | **自动唤醒**（respawn+resume 后执行） | 排队至 close 重评（删表则 Unknown threadId） | failure |
| ui_response | 路由 worker | 恒 ack、丢弃（弹窗随 worker 亡） | 恒 ack | 恒 ack |

worker 侧**单会话守卫**：threadId ≠ 当前会话 id → failure（纵深防御；fork 重键在飞
旧 id 命令由此结算）。

### 3.5 会话树/分叉

- **fork** `{threadId, seq, position?}` — 前置 `store.flush(id)`（内存尖 append 落盘
  ——防 fork 撞未落盘内存态误导文案），`before`（默认）/`at` → `store.fork(source,
  {untilSeq: position==="at" ? seq : seq-1, id: minted})`；fork 返回**已打开会话**——
  取 id 后立即 dispose（写锁释放），再走重装配 resume 路径。响应
  `{threadId:新, previousThreadId:旧, sessionPath}`。**旧 id 立即失效**；host 转发响应
  前先完成路由表重键。新会话模型经前缀事件继承（`session/meta{dial}` + `request/header`
  逐字节复制；重装配初值 = 前缀折叠加装配 fallback）。trusted 继承源线程。
  失败两段：校验类 → failure 线程保留；替换中途失败 → failure + thread_died（旧文件
  可 resume）。
- **fork 与在飞 turn（前置校验）**：isStreaming → failure `thread is streaming`；
  seq 超 log 边界（> events.length-1）→ failure `fork beyond durable boundary`
  （**边界 = 会话事件日志尾**——get_entries 与 fork 同域，客户端可见 seq 即可 fork 域）；
  position:"before" 且 seq=0 → failure `fork before first event`。
- **clone** `{threadId}` — fork at leafSeq（受同上 isStreaming 前置约束）。

### 3.6 模型与凭据

- **目录单真相 = `<agentDir>/providers.json`**（host 持有；形状 = x-harness
  ProvidersConfig 超集：`{providers: ProviderProfile[], default: {provider, model,
  thinking}, modelOverrides?: Record<modelId, {contextWindow?, maxOutputTokens?}>}`；
  ProviderProfile = `{name, protocol: "anthropic"|"openai", baseUrl, apiKey?, apiKeyEnv?,
  models: (string | {id, contextWindow?, maxTokens?, reasoning?, input?: ("text"|"image")[], cost?})[], contextWindow?,
  maxOutputTokens?}`——与 apps/cli providers.json 兼容，hub 增量字段向前兼容）+ 内置
  预设（GLM 档案，source:"preset"；custom 同名整档覆盖预设）。**坏 providers.json →
  一帧 hub_error + 目录降级为仅预设**（get_models 仍 success 返回预设集；修复后下次
  读取恢复）。
- **get_models** → `[{id, provider, contextWindow, maxTokens, reasoning, input?, cost?, source: preset|custom}]`
  （reasoning 恒在场——目录侧缺省 true；input 条件在场——携图能力门判据）。
- **凭据 = `<agentDir>/credentials.json`**（0600；provider 名 → apiKey；优先级 =
  credentials > providers.json apiKey > apiKeyEnv 环境变量）。**auth/list** →
  `{providers: [{provider, type:"api-key"|"preset-env"|"none"}]}`（**全目录成员**——
  迁移源仅列有存 key 者，扩大为全目录+三态，有意变更；永不含 key 值）；
  **auth/set_api_key** `{provider, apiKey}` — 写 credentials.json；provider 须在目录内；
  key 只从 stdin 进、全路径零回显（错误消息脱敏兜底）；**auth/remove_key** 幂等。
  worker spawn 时 host 经 env `HUB_WORKER_PROVIDERS` 传**已解析 apiKey 的装配快照**
  （单通道，worker 不读文件）；**adapter.name = provider 档案名**（dial.provider
  精确匹配注册名——多档案必须显式名，缺省名重复即注册拒绝）。
- **set_model** `{threadId, provider, modelId}` — worker 校验（装配快照查表：provider
  存在且 model 在档案内）后 `session/meta{key:"dial", value:{provider, model}}` +
  **flush** → 经 agentRequest waterfall 下一 turn 生效（waterfall 尾值改写 dial——内
  核自动记 `request/context`）。未知名 fail-closed 带清单。**保留档 × 目标模型不兼
  容**：当前 thinking meta 尾值非 off 且目标模型不支持（reasoning:false / openai
  协议）→ 写前拒 `cannot switch model: target model does not support the current
  thinking level — set_thinking_level off first or pick a compatible model`（两步舞
  指路，继承源语义）。
- **set_model_override** `{provider, modelId, contextWindow?, maxTokens?, remove?}` —
  窄合并写 providers.json modelOverrides 节 + 热刷新目录；`null` 值 = 仅清除该字段；
  校验失败不写文件；响应 `{model}`（刷新后完整模型对象）；启动期清扫
  `<agentDir>/*.pid.*.tmp` 残留。
- **models/add** `{id, provider?, protocol?, baseUrl?, apiKeyEnv?, contextWindow?,
  maxTokens?, reasoning?, input?: ("text"|"image")[], cost?}` → `{model}` — provider
  已存在则并入 models，否则必带 protocol+baseUrl 新建档案；input 词表外成员拒
  （写门不放拼写错误进盘）；目录现算——下一次 spawn 即热。
- **models/remove** `{id}` — 仅 custom 条目可删（预设裸名 → `unknown model preset`）；
  允许删被预设覆盖的 custom 条目（删除即恢复预设视图）；删除即时生效，在用会话撞已删
  模型 = LLM 调用错误收敛、worker 不死（自愈语义，不扫 parked WAL——预算 O(1)）。

### 3.7 直执行 bash

- **bash** `{threadId, command, timeoutMs?, excludeFromContext?, id?}` — worker 执行
  （cwd = 线程 cwd）：**同步认领槽位**（满 8 拒绝不逐出；无 id 在已有无 id 在跑时拒
  `concurrent direct bash requires a command id`；id 重复拒 `bash command id is already
  in use`；**id 缺省回落 = 命令请求 id**）→ DialogBroker confirm（超时 5min 默认拒绝）
  vs abort_bash 竞速（败者帧压掉，恰一响应）→ Bun.spawn 执行（流式
  `bash_execution_update` `{id, delta, truncated?}`；truncated 粘滞）→ **per-command
  AbortController 墙钟**（timeoutMs 正整数 ≤86_400_000、0=关、缺省
  HUB_BASH_TIMEOUT_MS；到点 `cancelled:true` 正常 success）→ 默认以 user/message 信封
  append + flush（`excludeFromContext:true` 不落）。内存累积封顶 8MiB（封顶后
  truncated 粘滞、增量继续转发但内存只留尾部）；输出超 1MiB 溢写
  `<agentDir>/bash-outputs/<seq>.txt`（fullOutputPath 只含封顶后内容；**启动清扫超
  7 天溢写文件**）。response（完成时返回）`{output, exitCode, cancelled, truncated,
  fullOutputPath?}`——output 64KiB 内联截断（truncated:true 标记）。进程树处置：
  detached 进程组 + SIGTERM 2s → SIGKILL 两段杀。
- **abort_bash** `{threadId, id?}` — 弹窗期 = 取消挂起准入（failure `aborted before
  execution started`）；执行期 = 带 id 只中止该命令（**id 不在跑时落穿为中止全部**——
  继承源行为），不带 id 中止该会话全部运行中直执行。

### 3.8 对话框 / agents / 宿主信息

- **ui_response** `{requestId, payload}` — 恒 ack。
- **agents/list** `{threadId?}` — host 本地：delegation `loadAgentTypes`（目录序 =
  project（trusted 时）> user > builtin）扫档；条目 `{name, description, source,
  model?}`（source = user|project|builtin）。
- **agents/create** `{name, description, systemPrompt, model?, tools?}` → `{path}` —
  frontmatter 严格集渲染（round-trip 复析保证：description 拒换行与字段形态行、
  systemPrompt 空串拒）；写 `<~/.x-harness/agents>/<name>.md`；同名 user 文件拒。
  **agents/remove** `{name}` — 现扫定 source，user 才删。
- **subagent/steer** `{threadId, agentId, message}` — worker 侧 gate（经
  `delegationView` 服务面直调，不走工具 dispatch）：目标非驻留 → failure
  `subagent <agentId> not available (status: <status>)`；**驻留即投递**（running →
  子代理步边界排队；idle → 立即唤醒开新轮——语义声明为有意变更，迁移源仅 busy
  可投，MIGRATION §4）。投递 = delegationView.message（agent.steer 同款机制）。
- **get_subagents** `{threadId}` → `{subagents: [...]}` — delegationView.list()
  ChildView 行原样 `{kind, agentId?, sessionId?, name?, ref?, type?, depth?, status:
  running|idle|stopped, work?}`（**状态词表 = 内核 ChildView 原样**，MIGRATION §4；
  work = spawn 任务摘要，T39 D10.2 起——spawn 在场恒有、复活自 header 回填可能缺席）。
  **消费模型（BATCH2 起）**：本命令是水化快照读（重连/首查一次）；状态增量经
  `agent/spawned` / `agent/status` / `agent/finished` 推送事件到达——**零轮询**
  （`[agent-notification]` 通知注入是父模型感知通道，与客户端事件面不同消费方）。
- **get_host_info** → `{version, bunVersion, pid, uptimeMs, rssBytes, threads:{live,
  parked,dead}, limits:{...}}`；不含路径/env/凭据。
- **set_idle_retire_ms / set_rss_retire_bytes** — 运行时旋钮（回 clamp 后值）。

### 3.9 设置 / 思考档 / 权限 / 信任（分层模型）

- **hub-settings.json 两级**：用户级 `<agentDir>/hub-settings.json`；项目级
  `<cwd>/.x-harness/hub-settings.json`（仅 trusted 装载）。白名单键（merge 语义）：
  `permission.defaultMode`（last-wins；`"plan"|"auto"|"full"`——内核 ModeKnob 词表）、
  `thinking.default`（last-wins；`"off"|"low"|"medium"|"high"|"max"`——内核
  ThinkingLevel 词表）、`skills.disabled`（union 并集；只收现扫合并清单内的名字）。
  **键分类扩展规则**：新白名单键必须声明 merge 语义三选一——last-wins / union /
  user-only（不下放项目级），否则不得进白名单。
- **settings/get** 无 cwd → `{values}`（用户级原值）；带 cwd（须 ∈ 信任集）→
  `{values, sources, raw}`——values = 合并视图（覆盖型项目胜、名单并集）；sources =
  `"project"|"user"|"union"`；raw = 两级原始值（回写事实来源；union 值不可直接回写）。
  陈旧 skills.disabled 名单惰性滤除（回显前按现扫清单，不写回）。
- **settings/set** `{key, value, cwd?}` — 白名单键值校验；无 cwd 写用户级，带 cwd
  （trusted 校验）写项目级（目录自建，原子写）；名单键整替目标级。
- **skills/list** `{cwd?}` → `{skills: [{name, source, path, disabled}]}`（cwd 过信任
  门禁；source = builtin|user|project——按目录层）；**skills/set_enabled**
  `{name, enabled, cwd?}` — 校验名 ∈ 现扫合并清单；带 cwd 写项目级名单（enable 后
  并集仍含 → `data:{stillDisabled:true, by:"user"}`——by 恒 user 级：带 cwd enable
  后并集残留只能来自 user 名单）；**skills/remove** `{name}` — 仅 user 级文件
  （project/builtin → `skill not user-defined`；删 user 遮蔽后 builtin 同名复活）。
- **思考档**：会话值 = `session/meta{key:"thinking"}`（last-wins，resume 天然恢复）；
  生效通路 = worker 装配的 **agentRequest waterfall 挂点插件**（每 step 从事件尾折叠
  写入 dial.thinking）。**set_thinking_level** `{threadId, level}` — 先词表校验
  （`invalid thinking level`）后流式拒（`thread is streaming`；判定面 = 受理窗口同
  prompt：turn 在飞 ∨ send 在飞）→ 模型兼容校验（`model does not support thinking`
  ——目录 reasoning 标志 + protocol 映射：openai 协议 non-off 档拒绝）→ append +
  flush，下一 turn 生效。**get_thinking_level** `{threadId}`（observer）→ `{level,
  source: "session"|"project"|"user"|"off"}`（**无值态归一 `"off"`——迁移源线缆值
  `"unset"`，归一为有意变更**，MIGRATION §4）。
- **权限 mode**：会话值持久化 `session/meta{key:"permission-mode"}`；装配初值序 =
  WAL 尾值 > thread/start|resume 入参 > 项目级（trusted）> 用户级默认。会话内即时 =
  内核 permission 插件**恒提供的 `permissionMode` 服务** `{get(), set(mode)}`——set
  原子切换 decide 面 mode + grants 授权面（GrantsRegistry.setUnrestricted(enabled)，
  离开 full 即撤——网络/extraRoots 授权面同步生效，非仅 decide 层）。**order 安全
  不变量：controller.set 后置于 flush 成功**（报失败但提权是最坏方向）。
  **permission/set_mode** `{mode, threadId?}` — 带 threadId（live）即时 + 落盘；
  不带 = 全局默认（写 hub-settings）。**permission/get_mode** `{threadId?}` →
  `{mode, source: "session"|"project"|"user"|"default"}`。作用域 = agent 工具调用
  裁决面 + grants 授权面；直执行 bash 的 confirm 不经 mode（§3.7 弹窗恒在）。
- **信任注册表** `<agentDir>/trusted-workspaces.json`（规范化 cwd 数组，原子写）：
  `thread/start|resume|register` 的 `trusted:true` 均自动登记；**workspace/trust**
  `{cwd, trusted:boolean}` 设/撤（无参 → `{trusted:[...]}` 全列表；cwd 非绝对 →
  `invalid workspace path: <cwd>`）。装载与命令面统一按「注册表 ∪ live trusted
  线程 cwd」集合判定。untrusted start 探测项目设置文件 →
  `projectSettingsPresent:true`。撤销不回收在途 live 线程的信任。
- **拉模型声明**：设置面无变更事件推送——客户端主动 get。
- **live 不可见声明**：项目设置/目录（models/类型/skills）变更对已 live 线程不生效
  （装配快照语义）；仅新装配取新值；会话内即时切仅 permission mode。

### 3.10 会话删除

- **thread/delete** `{sessionPath}` → success `{data: {removed: [threadId…]}}`（本次
  实际 rename 成功的目录名集，级联子按 BFS 序；**幂等**：目录已不在 = success
  `removed: []`；对齐 thread/stop「未知 success」先例）。host 本地命令（不进池、
  worker 无感知、internal 四集合不动）。输入键 = sessionPath（对齐 resume/register
  ——作用于存档的命令族；stop/retire 的 threadId 是活线程操作族，分野有意）。
- 语义序：**只读检查段**（shapeFence 词法 + realpath 围栏拒 symlink 逃逸 → 目录缺席
  即幂等 success 并撤表残留 → lock 探活拒活进程 → header.agentId 拒子代理会话 →
  parentSession 血缘 BFS 级联集）→ **状态变更段（同步表操作与 rename 之间零 await）**：
  占用表活族（live/spawning/retiring）→ failure **`already open`**（显式两步：先
  thread/stop）；parked/dead → 撤表 → **原子 rename-to-trash**
  （`<agentDir>/trash/<id>.<pid>.<rand>`；sessionsRoot 即刻消失，一切后续
  stat/lock/register 干净失败）→ 异步 rm（trash 残迹由 tmp-sweep 扩清——mtime > 1h）。
- 级联：子代理会话（header.parentSession 血缘，含孙代）一并删除——子会话在
  list_saved 不可见，不级联即永不可清的隐形垃圾。
- lock 探活：读 `<dir>/lock`（纯 pid）+ kill(pid,0)——活 → failure `session is
  locked by another process`；死 pid/垃圾内容放行（rm 连锁清）。探活先行兼覆盖
  「子会话创建中 header 未落」窗口。check-then-act 窗口由 rename 原子性收窄到瞬时；
  **跨 host 并发删除同一会话不在支持矩阵**（已知边界）。
- 无 header 的孤儿目录（半创建残迹）仍删；无 lock 无 header 的目录 = 死数据。
- bash spill（agentDir/bash-outputs）不随会话删——tmp-sweep 7 天兜底（既有语义）。

## 4. 输出帧与事件词表

| 帧 | 说明 |
| --- | --- |
| `response` | `{id?, command, success, data?\|error}`（恰一契约；id-first key 序单点） |
| `event` | `{threadId, name, payload, agentName?}` — worker 盖章 threadId（= 其当前会话 id；host 逐字转发）；`agentName` = 子代理归属帧的 agentId（BATCH2 起激活：桥由 `agent/spawned` 事件播种 session→agentId 映射，凡 payload 携带子会话 session 的帧即填；sessionDisposed/换会话清） |
| `ui_request` | `{requestId, threadId, method, ...}`（§6） |
| `heartbeat` | 1Hz `{rssBytes, cpuPercent}`（host 自身） |
| `hub_error` | 未捕获异常报告（进程不退出；worker 源带 threadId） |
| `thread_died` | `{threadId, reason}` 恰一 |
| `thread_parked` | `{threadId, reason: idle\|manual\|rss}` 恰一 |

**事件词表（认领集 + 未知透传）**：

- **session 域**（`sessionEvent` bus 镜像——与 WAL 事件一一对应，payload 携带
  `{seq, time, ...data, session}`；**session 归属字段（BATCH2 起）**：主会话帧
  session === threadId，子代理会话帧 session = 子会话 id——客户端一条规则过滤归属；
  子会话帧外发但不喂主线程观察态）：`turn/start`、`turn/end`（reason = TurnEndReason
  判别联合 `{kind: completed|aborted|blocked|error|max-tokens|interrupted, ...}`）、
  `step/start`、`step/end`、`system/message`、`user/message`、`assistant/message`、
  `assistant/attempt`、`tool/call`、`tool/result`、`request/header`、
  `request/context`、`llm/retry`、`session/end-seed`、`agent/inbox/spliced`
  （InboxSpliceData 判别联合原样）、`autocompact/checkpoint`、`todo/snapshot`、
  `session/meta`、`command/run`/`command/done`（BATCH3：命令生命周期 log-only 配对，
  commandId 配对镜像 tool/call↔tool/result；args 缺席 = recordInput:false；不开 turn、
  不进模型上下文；恢复面配对校验 at-most-once 双向，悬挂 run 合法）。
- **实时域**（bus 事件 token 原名透传）：`agent/assistant-stream`（payload =
  `{session, turn, step, frame}`——AssistantStreamFrame：start / chunk（**仅
  `{kind:"text"|"thinking", text}`**）/ end；**子代理模型增量经本面到达**——llm/chunk
  仅主会话，不双通道重复）、`agent/status`（`{session, status:
  idle|running}`）、`agent/error`（`{session, turn, message}`）、`agent/tool-stream`
  （`{session, callId, delta}`——内核工具增量事件，BATCH2 起，主/子会话均外推，
  delta 为原始字节流口径——ANSI 清洗是 tool/result 结算口径）、
  **`agent/spawned`（BATCH2 §3）** `{parent, agentId, sessionId, type, depth, work?}`——
  spawn 成功与 revive 复活两处发射（work = spawn 任务摘要；复活发射可能缺席——
  旧档案无 agentWork 字段）；**`agent/finished`（BATCH2 §3）**
  `{parent, agentId, sessionId, outcome: completed|stopped|failed, detail, summary?}`——
  **每运行周期恰一次**（非生命周期终态：stop 后可复活再发；终态以 get_subagents
  快照对账）；deliver 单点（正常/stopAll 级联/孤儿收养）+ spawn kick 失败闭环 +
  stop-idle 子同步发射；thread/stop 与 fork 拆除序 = stopAll 先于桥拆除（finished
  边沿可达客户端）、`compaction/landed`、
  `compaction/served-window`、`compaction/diagnostic`、`autocompact/*` 事件族、
  `permission/decided`、`session-checkpoint/diagnostic`、`session/created`、
  `session/disposed`。
- **llm/chunk 归属（BATCH2 起）**：仅主会话流外发（request.session 判据）；子代理
  流的 text/thinking 增量经 `agent/assistant-stream`（payload 已含 session）。
- **worker 合成域**：
  - `llm/chunk` `{turn, step, chunk}`——worker 挂 `llm/stream` waterfall tap 中间件
    逐块转发 LlmChunk（`text-delta`/`thinking-delta`/`tool-call-delta`/`usage`/
    `finish`——内核事件面只含 text/thinking 增量，工具增量/usage/finish 经本合成域
    到达客户端；turn/step 由桥从 agent/assistant-stream 帧跟踪）。
  - `settled` `{sendId, ok, reason?}`——**恰一不变式：每个被受理的驱动命令
    （prompt/steer/follow_up，带 id）恰一个 settled**。sendId = 命令 id；触发 = turn
    收敛（whenIdle 达成）或受理失败；**worker 死亡时 host 对在飞未 settled 的驱动
    id 合成 `settled{ok:false, reason:"worker-died"}`**。排序承诺：settled 必在本
    输入引发的最后一个 turn/end 之后；abort/clear_queue 不取消 settled（仍发，ok
    反映实际收敛结果；turn/end reason 为 error/blocked → ok:false 带 reason）。
  - `agent/tool-stream` `{session, callId, delta}`——模型工具执行增量（内核
    agentToolStream 事件；桥 per-callId 尾沿合并 ≥25ms——delta 可连接合并不损；
    tool/result 到达时尾批冲净；get_inflight 的 toolOutputs 同步逐 delta 追加不受
    节流）。
  - `bash_execution_update` `{id, delta, truncated?}`。

**消息权威终局**：`assistant/message` WAL 事件是本步消息的权威终局（content/
stopReason/usage）；跨步/重连对账以 WAL 为准（get_entries since=turnStartSeq 增量
拉取）。**重连水化配方**：重连/刷新后 `get_entries{since}` + `get_inflight` 并行
拉取、幂等合并即收敛；事件实时流不补偿（丢失补偿源 = WAL）。

## 5. worker 侧装配与语义映射

worker = `createAgentWorld` + kit 配方（`promptKit` / `durableSessionKit` /
`toolboxKit` / `fenceKit` / `meterKit` / `compactionKit`+`autoCompactKit` /
`llmKit(adapters)` / `loopKit` / `checkpointKit` / `delegationKit` / `skillKit`）+
`loop.create/resume` 单会话。trusted 决定 skills/agents project 级目录与项目级设置
装载（workspace=cwd 显式锚）。permission 即时面经 `ctx.use(permissionMode)` 服务
（插件恒提供，§3.9）。

| 迁移源（@my-agent） | host-hub（@x-harness） |
| --- | --- |
| Agent.send（命令路由/skill 展开/多模态） | `agent.followup(text)`（纯文本；/compact 拦截 hub 侧；无命令路由面） |
| loop.steer/followup（userMessage 含 images） | `agent.steer/followup(text, {images})`——内核 ContentBlock 已含 image 块（BATCH2） |
| loop.cancel + manager.cancelAll | `agent.cancel(cause)` + delegationView.stopAll（子代理级联） |
| compactionRunner.compact({messages,...}) | `compactionRunner.compact({session, trigger, customInstructions, keepRecentTokens, signal})` → CompactionResult |
| model-change 事件（+flush） | `session/meta{dial}` + agentRequest waterfall 改写（内核自动记 request/context） |
| getEntries/getLeafId | WAL seq 游标 + fork 谱系（hub 折叠） |
| executeBash/abortBash | 直执行器（Bun.spawn + per-command AbortController + detached 进程组两段杀） |
| 权限 ask rules/sidecar | permissionBroker 服务 → ui_request confirm（permissionMode 服务即时切） |
| 子代理 registry/grant | delegationView 服务面（list/message/stopAll——内核加法直调） |
| thinking 档 request/compose 挂点 | agentRequest waterfall 挂点（dial.thinking 尾值改写） |

**providers 参数化注入**（测试缝）：env `HUB_WORKER_PROVIDER=script` +
`HUB_WORKER_SCRIPT`（JSON 剧本内联——步骤 `{reply, thinking?}\|{toolCalls}\|{error:
{code, retryable?}}\|{delayMs}`，hub 侧 script-adapter 映射 LlmChunk 流）；生产 =
host 经 `HUB_WORKER_PROVIDERS` 传装配快照（已解析 apiKey 的 ProviderProfile[]，worker
按 protocol 构造 compat adapters；**adapter.name = 档案名**）。

**直写会话纪律**：worker 侧直写（bash 信封/dial/thinking/title/permission-mode/
clear）每次 append 后跟 `store.flush(id)`（loop 只在轮边界 flush；空闲期直写不
flush 即崩溃丢失）；**fork 前 store.flush(id)**（§3.5）。

## 6. 对话框子协议

host 发 `ui_request {requestId, threadId, method, ...}`：

| method | 语义 | 应答 payload |
| --- | --- | --- |
| `confirm` | 权限确认（工具调用/直执行 bash；AskRequest{tool, reason}——展示信息量以两字段为限） | `{"confirmed": bool}` |
| `select` / `input` | 预留扩展面 | `{"value":"..."}` 或 `{"cancelled":true}` |
| `notify` / `setStatus` | 提示（fire-and-forget） | — |

**confirm 超时统一 5 分钟（300_000ms，常量单点 limits.ts）**。不变量：恰一 settle
（response/**强制超时**/abort，后两者默认 deny）；晚到忽略恒 ack；requestId 由 worker
分配；host 不持弹窗状态（恒 ack + 广播 live worker）；RESERVED 帧头键 + `__proto__`
注入过滤。**无弹窗撤回帧**：worker 死亡经 thread_died 推断、超时由 broker 默认值结算。

## 7. worker 心跳与生命周期

- worker→host 心跳 1Hz：`{idleMs, streaming, sessionPath, rssBytes}`——worker 侧
  真相。busy = streaming ∨ **send 在飞（pendingSends > 0——受理窗口内 idleMs=0）**
  ∨ 手动压缩中 ∨ 弹窗挂起 ∨ 子代理任务在飞 ∨ 自执行器有在跑命令（**idle retire
  例外**：在跑直执行 bash 不收编——stale 杀线照旧）；observer 命令不重置 idle。
- 状态机：`spawning → live →（闲置≥15min）retiring → parked`；`live → dead` →
  thread_died 恰一 → 写命令自动复活。retiring 排空途中真崩溃 → 按 died 结算；超时
  强杀 → 仍按 parked 结算。复活 spawn 失败 → 表项保持 dead + 命令 failure。
- **stdout close（非 exit）是死亡信号**；close 后按 id 对账合成 failure（恰一）。
- 孤儿自灭（stdin EOF / EPIPE）；宁可杀错（stale 30s：SIGTERM 2s → SIGKILL）；
  优雅退出有界（超时强杀，终态按 retire 结算）。
- idle retire 只收编已落盘 worker；RSS 硬顶无视 keepalive/busy（未落盘超顶走 kill
  非 park）；rss 样本 NaN 防御。
- 占用表：spawning 即占位；`path.resolve` 比较；心跳再同步单向迁移（null→path /
  path→path；null 不回写）；resume 先等 retiring 持有者（有界，wedged 强杀）；**dead
  表项持有者直接接管**（撤位重建）；失败 spawn 句柄走 onClosed 回收。
- per-thread 会话替换三操作（fork/clone/stop）串行；stop-vs-wake 以 stopRequested +
  闭包 worker 引用结算。
- **唤醒有界重试（1s × 12 拍）**：覆盖 spawn/IO 瞬态失败。**会话锁接管是即时的**
  （内核判据 = 持锁 pid 活性探测，死 pid 立即 rename+wx 接管——无 staleness 时间
  窗）；pid 复用误判存活属安全侧失败面（复活 failure，如实可观察）。
- **resume 同步占位**：词法围栏（绝对路径/布局/id 词法 = 内核 isSafeSessionId）+
  占用声明在**任何 await 之前**同步完成（消灭双开竞态窗口）；realpath 圈内复核与
  存在性在占位后异步执行，失败撤位应答；对 retiring/spawning 持有者有界等待释放
  （≤12s）。

## 8. 内部问题域

**处理**：进程编排；命令路由与恰一对账（全终路）；帧中继（前缀分类零解析）；
JSONL 分帧；stdout 接管与串行帧写；两级心跳；占用表与 fork 重键；直读
（get_state/get_entries 免唤醒）；模型目录（预设+providers.json+modelOverrides 热刷新
+credentials 叠加+装配快照注入）；凭据存储；worker kit 配方装配；事件桥（含
llm/stream tap）；对话框中继；直执行 bash（含溢写 7 天清扫）；收敛读口；队列折叠
（foldInbox host/worker 共用）；设置两级分层与信任注册表；thinking/permission 会话面
（permissionMode/delegationView 内核服务消费）；thread/list_saved/get_tree 谱系折叠
（子代理会话滤除）；host_info/旋钮。

**不处理**（归属）：

| 不处理 | 归属 |
| --- | --- |
| 权限规则引擎/裁决 | @x-harness/permission（broker 只传输；mode/授权面归 permissionMode 服务） |
| 子代理委派/预算/通知 | @x-harness/agent-delegation（hub 只消费 delegationView + 中继事件） |
| 会话 WAL/写锁/fork/恢复 | @x-harness/session + session-persistence-jsonl（hub 只围栏与路由） |
| 命令注册/dispatch | **已支持（BATCH3）**：内核 `@x-harness/commands` 注册面 + kit 自声明（compact）+ execute 分路；未注册词形仍交模型（skill 分发面） |
| sandbox/远程工作区 | @x-harness/sandbox-local（fenceKit 装配面） |
| 后端注册表/能力协商 | 单一后端（hello 握手：`{protocolVersion:1, backendId:"x-harness"}`） |
| OAuth 交互式登录 | auth/set_api_key 单通道 |
| 跨机器/远程接入 | stdio 单机限定 |
| 会话删除 | **已支持（§3.10 thread/delete，BATCH2）** |
| prompt images 已支持（§3.2）；已知边界：多轮携图全量投影受 get_messages 100MiB 软上限（超限 failure 引导 get_entries）、64MiB 直读上限（register 拒/list_saved 跳过——既有降级面携图更易触达）、compaction 折叠摘要以 `[image: <mediaType>]` 占位 | 量限/边界声明（BATCH2-DESIGN §1） |
| 工具结果带图（pi 支持，内核 ToolOutcome 为单串） | 另一契约，挂账 |
| telemetry sqlite | 不装（产品面未消费；后续按需加 kit） |
| 跨进程 mailbox IPC | 不用（host↔worker 走 stdio 管道 JSONL） |

## 9. 并发与性能预算（违反 = 缺陷；括号内为测试锚）

- host 转发路径 <1ms、零磁盘 IO、零 JSON.parse（锚：frame-classify 单测断言不 parse
  body + smoke 计时断言）。
- 帧写：全局串行队列；ENOBUFS/EAGAIN 10ms 重试**上限 100 次**后降级 **stderr 日志**
  + 帧丢弃计数（锚：stdout-guard 注入用例）；EPIPE 优雅退出。
- stderr 排障面（两级前缀 `hub:` / `hub:worker:<threadId>`）：必记事件 = worker
  spawn/retire/kill（含原因）、死亡对账合成（补 failure/settled 计数）、hello 拒载、
  providers.json 降级、ENOBUFS 降级、直写 flush 失败。
- 定时器：host 常驻 2（心跳+sweep）+ 每 worker 动态死线；worker 常驻 1（心跳）+
  动态（bash 墙钟/ask 超时）（锚：单测计数断言）。
- 内存：host 常驻 <150MB、parked 零常驻、非 live 表项 1024。
- spawn 冷启动目标 P50 ≤2s（锚：场景计时记录项，CI 上限 10s 宽放行）。
- 回调内禁 IO：帧中继/心跳投影路径零磁盘网络。
- 三档行限 + host→client 无上限（§2）。
- list_saved O(会话数 × 全量 read)；>64MiB 单会话跳过（§3.1）。
- 事件桥订阅为 per-agent scope（agent dispose 即回收，无监听泄漏）。

## 10. 裁决落档汇总

- 【用户裁决】立项：把 my-agent host-hub（已核销）迁移到 x-harness apps 目录；不是
  直接复制——迁移源的功能全集（55 命令、可靠性机器、设置分层）为规格基线，底座换
  x-harness 内核，产品后续接 app；要求生产可用、高性能；执行不间断直至收口。
- 【裁决·D1-D4】见 §0。
- 【内核纯加法四件】（迁移即需要，均纯加法/可选参）：`session/meta` 日志事件
  （core/session）；permission 恒提供 `permissionMode` 服务 + GrantsRegistry
  `.setUnrestricted(enabled)` 可撤销授权面（permission）；skill `disabled` 名单
  （skill）；delegation `delegationView` 服务面（list/message/stopAll）+ barrel 导出
  types-loader（agent-delegation——hub 直调绕开工具 dispatch 的 permission ask 墙）。
- 【继承裁决】恰一响应（全终路）；stdout close 死亡判定；孤儿自灭；宁可杀错；
  spawn 即占位；fork 换 id + 转发前重键 + fork 前 flush；观察命令不重置 idle；
  JSONL 自研分帧 + 行限三档；stdout 两层接管；ui_request 恰一 settle + 强制超时；
  64KiB 在途尾部 + truncated 粘滞；收敛读口空形态 + 水化配方；唤醒有界重试（锁接管
  即时）；resume 同步占位；信任注册表 ∪ live 集合判定；设置 raw 两级回写事实源；
  bash 溢写 7 天清扫；worker 响应单点 respond() id-first 序。
- 【有意变更】（客户端对接注意；明细 MIGRATION §4）：事件词表重列（x-harness 内核
  词表 + llm/chunk 合成域）；seq 0 基；turn/end reason 判别联合；get_entries event
  摊平形状；get_subagents ChildView 词表；get_commands source 收缩 skill|builtin；
  images 显式拒绝；get_session_stats cost 在场透传（升级）；compact 响应
  +summaryTokens；providers.json 取代 models.json（形状超集）；permission mode 词表
  plan|auto|full；thinking 词表 +max、无值态 unset→off 归一；providers 经 env 装配
  快照注入；斜杠命令交模型（无 unknown-command settled 面）；subagent/steer 字段
  agentId + 驻留即投递（running 排队/idle 唤醒）+ 新错误文案；auth/list 全目录三态；
  list_saved 查询键收窄 {cwd?}、forkSeq 缺席、updatedAt 派生；撕裂写中段坏行
  fail-closed；abort_bash unknown id 落穿中止全部；bash id 缺省回落请求 id；
  get_state.model 字段改名（modelId→model 复合形）。

## 附录 A：错误文案封闭清单（smoke 断言以此为准；新错误同风格进本表）

| 文案 | 触发 |
| --- | --- |
| `parse failure` | 非对象 JSON / 超行限（command 字段 = "parse"） |
| `unknown command` | 未知 type |
| `threadId required` | 线程域命令缺 threadId |
| `Unknown threadId` | 表中无此线程（含 1024 逐出后） |
| `too many live threads (limit reached)` | 准入预算（HUB_MAX_THREADS） |
| `too many in-flight commands` | 命令风暴上限（pendingCommands 65536） |
| `already open` | 同 sessionPath 已占用（start/resume/register；thread/delete 对活族同串复用） |
| `cannot delete subagent session` | thread/delete：header.agentId 在场（子代理会话归 delegation 生命周期管理） |
| `session is locked by another process` | thread/delete：目录 lock 持有活进程（跨 host 防线） |
| `delete failed: rename` / `delete failed: <code>` | thread/delete：rename/stat 异常如实上报（目录原子消失失败） |
| `response too large; use get_entries` | get_messages 软上限（100MiB JSON 串长） |
| `session path outside sessions dir` | resume/register/delete 围栏（绝对路径/realpath 圈外） |
| `Session file not readable` | 零字节/空卷/不可读 / register >64MiB |
| `cannot resume session: <reason>` | 内核恢复器失败透传（含 archive-corrupt 中段坏行） |
| `thread is streaming` | 流式中拒（fork/clone/compact/set_thinking_level） |
| `streamingBehavior required while streaming` | 流式中 prompt 未带 streamingBehavior |
| `Compaction already in progress` | compact 双发 |
| `context too small to compact` | compact 不可压/摘要输入空/摘要空（归一） |
| `compaction failed: <reason>` | summarize-failed / summary-truncated / llm-unavailable / replace-failed / session-unknown |
| `compaction summarizer not configured` | 压缩摘要器缺席 |
| `compaction aborted` | compact 被 abort 中断 |
| `fork beyond durable boundary` | seq > 日志尾 |
| `fork before first event` | position:"before" 且 seq=0 |
| `invalid fork seq` / `invalid limit` / `invalid name` / `invalid timeoutMs` / `invalid since cursor` / `invalid before cursor` | 参数校验族（后跟原因） |
| `concurrent direct bash requires a command id` | 无 id 并发直执行 |
| `bash command id is already in use` | id 重复认领 |
| `too many concurrent direct bash executions (limit reached)` | 槽位 8 满表 |
| `aborted before execution started` | 弹窗期 abort_bash |
| `subagent <agentId> not available (status: <status>)` | subagent/steer gate（非驻留） |
| `unknown model preset: <name> (available: <list>)` | set_model/models 面未知名 |
| `cannot switch model: target model does not support the current thinking level — set_thinking_level off first or pick a compatible model` | set_model 保留档 × 目标不兼容 |
| `auth provider not in catalog` | auth/set_api_key 域外 provider |
| `shutting down` | 关闭期新命令 |
| `Session not persisted yet` | retire 未落盘线程 |
| `permission denied` | 直执行 bash 确认拒绝 |
| `invalid images: expected array` / `invalid images: bad block` / `invalid images: type must be image` / `invalid images: data must be non-empty base64` / `invalid images: mediaType required` / `invalid images: too many images (max 8)` / `invalid images: image too large (max 5242880 base64 chars)` / `invalid images: images too large in total (max 12582912 base64 chars)` / `invalid images: model does not accept images` / `invalid images: compact does not accept images` | images 坏形状/量限/能力门/compact 拒图（shared/images + meta-state 单点） |
| `invalid id: reserved namespace` | 客户端 id 冒用 `@hub-internal:` 前缀 |
| `unknown setting key: <key>` / `invalid setting value: <reason>` | hub-settings 白名单键值校验 |
| `invalid model entry: <reason>` | models/add 校验族 |
| `agent type already exists: <name>` / `unknown agent type: <name>` / `agent type not user-defined: <name>` / `invalid agent type: <reason>` | agents 类型管理面 |
| `unknown skill: <name> (available: <list>)` / `skill not user-defined: <name>` | skill 管理面 |
| `invalid thinking level: <level>` / `model does not support thinking` | 思考档面（词表外 / reasoning:false / openai 协议） |
| `thinkingLevel rejected: <reason>` | thread/start\|resume 显式档 × 模型不兼容（静默降级外的显式拒——对称 permissionMode 校验） |
| `invalid permission mode: <mode>` / `thread not live` | 权限双域面（set_mode 词表外 / parked·dead·retire 在飞） |
| `worker died before responding` | close 结算对账合成 |
| `fork reassembly failed: <reason>` | fork 重装配失败 |
| `invalid: nothing to set (provide contextWindow/maxTokens or remove)` / `invalid: remove is exclusive with field updates` / `invalid: <value> must be a positive integer or null` / `invalid: <value>` / `invalid: apiKey required` | set_model_override / auth / 旋钮校验族 |
| `invalid command: required` | bash 空 command |
| `invalid images: compact does not accept images` | /compact 拦截携图 |
| `skills plugin unavailable` | get_commands 装配不变量破坏面 |
| `invalid setting value: trusted must be a boolean` | workspace/trust 入参校验 |
| `invalid workspace path: <cwd>` | workspace/trust 相对路径 |
| `untrusted workspace: <cwd> (trust it via workspace/trust or a trusted thread start)` | 设置/skills 面 cwd 门禁 |

（迁移源 `inbox-full` 文案退役——内核 inbox 无容量面；`thinking budget exceeds
maxTokens` 退役——预算钳制归内核 llm 拨号层。）

## 附录 B：命令 success data 形状表（未列命令 = 无 data 字段）

| 命令 | data |
| --- | --- |
| thread/start / resume / register | `{threadId, cwd, sessionPath}`（start/resume 另含可选 `projectSettingsPresent:true`） |
| workspace/trust | `{trusted: [...]}`（无参列表形态）；设/撤形态无 data |
| thread/list | `[{threadId, cwd, sessionPath, state, idleMs, rssBytes, keepalive, isStreaming}]` |
| thread/list_saved | `{sessions: SessionSummary[]}`（§3.1 折叠形状） |
| clear_queue | `{steering: string[], followUp: string[]}` |
| compact（含 /compact 拦截） | `{summary, replacedCount, summaryTokens}` |
| get_state | `{model, isStreaming, isCompacting, sessionId, sessionName, sessionFile, messageCount, queue}` |
| get_inflight | `{turnStartSeq, turnStartedAt, message, toolOutputs, bash}` |
| get_messages | `{messages}` |
| get_entries | `{entries: [{seq, ts, event}], leafSeq, hasMore}` |
| get_tree | `{ancestors, children, leafSeq}` |
| get_session_stats | `{userMessages, assistantMessages, toolCalls, toolResults, tokens:{input,output,total,cost?}}` |
| get_commands | `[{name, description?, source}]` |
| get_fork_messages | `[{seq, text}]` |
| get_subagents / get_pending_dialogs | `{subagents: [...]}`（§3.8 形状）/ `{dialogs: [{requestId, threadId, method, payload}]}` |
| fork / clone | `{threadId, previousThreadId, sessionPath}` |
| get_models | `[{id, provider, contextWindow, maxTokens, reasoning, input?, cost?, source}]`（reasoning 恒在场，input 条件在场） |
| models/add | `{model}` |
| set_model_override | `{model}` |
| auth/list | `{providers: [{provider, type}]}`（全目录三态） |
| bash | `{output, exitCode, cancelled, truncated, fullOutputPath?}` |
| agents/list | `{agents: [{name, description, source, model?}]}` |
| agents/create | `{path}` |
| skills/list | `{skills: [{name, source, path, disabled}]}` |
| skills/set_enabled | ack（enable 后并集仍含 → `{stillDisabled:true, by:"user"}`） |
| settings/get | `{values}`（无 cwd）/ `{values, sources, raw}`（带 cwd） |
| get_thinking_level | `{level, source: "session"\|"project"\|"user"\|"off"}` |
| permission/get_mode | `{mode, source: "session"\|"project"\|"user"\|"default"}` |
| get_host_info | `{version, bunVersion, pid, uptimeMs, rssBytes, threads:{live,parked,dead}, limits}` |
| set_idle_retire_ms / set_rss_retire_bytes | `{value}`（clamp 后生效值） |
| prompt / steer / follow_up / abort / thread/stop / retire / set_keepalive / set_model / set_session_name / auth/set_api_key / auth/remove_key / abort_bash / subagent/steer / ui_response / settings/set / models/remove / agents/remove / skills/remove / set_thinking_level / permission/set_mode | 无 data（受理即全部信息；结果走事件流） |

## 附录 C：事件载荷权威指针（单一事实，防双写漂移）

- **session 域 + 实时域事件载荷**：权威 = `packages/core/session/src/types.ts`
  （SessionEventData 词表）与各内核包 tokens.ts（bus 事件 payload 类型）——本协议逐字
  转发其 payload，不复制字段表（复制即漂移）。关键复合形状内联：
  - `agent/inbox/spliced`：InboxSpliceData 判别联合（insert/claim/clear）；
  - `agent/assistant-stream`：`{session, turn, step, frame: AssistantStreamFrame}`
    （chunk 仅 `{kind:"text"|"thinking", text}`——工具/usage/finish 增量走 `llm/chunk`）；
  - `turn/end`：`{turn, reason: TurnEndReason}`（判别联合）。
- **合成域（host-hub 自有，本文件 §4 为权威）**：`llm/chunk {turn, step, chunk:
  LlmChunk}`；`settled {sendId, ok, reason?}`；`bash_execution_update {id, delta,
  truncated?}`。
