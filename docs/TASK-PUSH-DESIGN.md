# TASK-PUSH：任务交付从拉制转推送制（件14 修订）

> 状态：**已定稿**（两路对抗审查 28 项全处置 §10；待开工令）
> 级别：中（task-tools 收窄 + tool-bash 登记簿重写 + agent-delegation 死链清理 +
> tool-core 围栏增根 + e2e 旅程改写）
> 上游：件14（docs/TASKS.md）「LLM 面 = task_output + task_stop 两工具」终态由本件
> **显式修订**为「task_stop 单工具 + 推送交付 + 文件读面」。
>
> **用户裁决（2026-09-24 一次）**：删除 task_output——子代理报告已是推送交付
> （[agent-notification] 通知即全文），拉面退役；bash 后台任务重写为「stdout/stderr
> 落文件 + 结束主动通知」，与子代理同构。
> **用户裁决（同日二次，AskUserQuestion 落档）**：① 日志生命周期 = **会话档案一致性**
> （任务日志随会话档案生命周期清理，非进程临时目录）；② 通知正文 = **尾部小帽 + 路径**
> （状态行 + 日志路径 + ~4KB 尾部切片；不照搬 reportCap 34000 全文直送）。

## 0. 目标与终态

**终态**：

- LLM 面只有 `task_stop` 一个任务工具（停 bash 后台任务 / 停子代理）；`task_output`
  整体退役，`offset/block/timeout` 参数族随之消亡。
- bash 后台任务（run_in_background）：stdout/stderr **流式落盘**单文件（到达序并流），
  返回值携带日志路径；finalize 时经 notify 通道主动推送 `[task-notification]`
  （状态行 + 路径 + 尾部切片）；运行中读面 = 模型用既有 read/grep 工具读日志文件。
- 子代理面（agent-delegation）零行为变更：通知即全文交付仍是唯一交付路径；
  task_output 删除带走其拉面死链（reportDelivered 整链）。

**不做（落档 §9）**：任务枚举工具、跨源统一 id、任务持久化跨重启、remote 源——
沿件14 §9 裁决不变。

## 1. 现状与删除依据

### 1.1 task_output 现存职责盘点（删除正当性）

| 职责 | 现实现 | 删除后去向 |
| --- | --- | --- |
| agent 报告拉取 | verbs.ts output()；通知已全文直送（notify.ts reportCap 34000），output 仅剩 reportDelivered 复查不复读 + 封存窗口兜底 | 通知即唯一交付（现状主路径不变）；复查走 agent_message 追问 |
| agent 运行中窥视 | block:false / timeout 到点回 running 快照 + last output so far | **无面**（反轮询既有裁决：禁「好了吗」循环；中途要信息走 agent_message steer） |
| agent 同步等待 | block=true raceIdle 有界等 | spawn 返回文案已是「等 [agent-notification]」推送范式（spawn.ts:241）；删除是顺势收口 |
| bash 输出读 | 唯一读面：内存 ChannelCollector + offset/nextOffset 增量切片 | **文件读面**：日志落盘，read/grep 读日志文件（能力边缘见 §8 声明） |
| bash 完成等待 | block=true waitSettled 轮询 list() | **推送**：finalize → [task-notification]（零轮询，更符合反自旋） |
| bash 停止 | task_stop（保留） | 不变 |

### 1.2 reportDelivered 死链

task_output 删除后 `ChildRow.reportDelivered` 零消费者（lineage.ts:23 注释自认消费者
即 task_output 复查）。按「同一事实单一实现」整链删除：lineage 字段 +
spawn.ts:125 / revive.ts:62 置位 + notify.ts:222 置位与注释。通知投递 try/catch 丢弃
窗口（父恰在封存）保留现状语义：emitFinished 事件面仍发射，宿主 UI 可见。

## 2. 设计

### 2.1 task_output 删除面

- task-tools `tools.ts`：只余 task_stop；`precheck`/`route`/`notFoundText` 保留（stop
  仍走路由）；`outputSchema` 删；block 归一化注释随参数族删。
- `descriptions.ts`：TASK_OUTPUT_DESCRIPTION 删；TASK_STOP_DESCRIPTION 原文保留
  （正文未提 output）。
- `tokens.ts`：TaskOutputOptions 删；**TaskSource 接口收窄**——`output()` 方法删除，
  只余 `kind/probe/stop`（接口同步收窄，不留无实现者的方法声明）。
- `source-bash.ts`：output 分支 + bashReadText 删；waitSettled/probe/stop 保留（stop
  收敛仍用）。
- agent-delegation：`verbs.ts` 删 output()/OutputInput/reportText()/reportHead()
  /raceIdle()（后两者仅 output 消费）；summaryLines 保留（notify.ts 通知仍用）；
  `task-source.ts` 删 output 分支。
- harness `kits.test.ts`、apps/cli `resolve-agent-options.test.ts`（REGISTERED 与
  --exclude-tools 期望清单）同步去 task_output。
- **结构性头注释按语义清理**（verbs.ts/task-source.ts/tools.ts/index.ts 等头部注释中
  的 output/block 语义提法——grep 锚只是验收下界，不覆盖不含关键字的语义提法）。
- **grep 锚**：src 全仓 `task_output|TASK_OUTPUT|TaskOutputOptions|TaskRead|
  reportDelivered|bashReadText` 清零（docs 历史节除外）。

### 2.2 bash 登记簿重写：文件日志（tool-bash/tasks.ts）

**路径契约**：`<taskLogDir>/<sessionKey>/bash-task-<id>.log`；
`sessionKey = String(sessionId)`（isSafeSessionId 词表保证目录名安全）/ 匿名会话
`_anon`（词表首字符不含 `_`，与真实会话目录零碰撞）。

**taskLogDir 配置链**（沿「插件配置由使用端决定」裁决——插件不嗅探目录）：
`TaskLimitsOptions.taskLogDir?: string`（tool-bash/plugin.ts）；缺省
`mkdtempSync(join(tmpdir(), "x-harness-tasks-"))`（进程级临时——裸 SDK 世界形态，
通知尾部切片为唯一持久面，落档 §8/§9）。宿主（host-hub）传 `<hostData>/task-logs`——
会话档案一致性由此成立（§2.3 生命周期）。

**TaskLimits 收窄**：`maxOutputBytes`/`spillDir` 两字段删（消费者 read 切片/spill 写
随本件消亡）；`fullCapBytes` 语义迁移为文件写帽（缺省 64MB 不变）；
`defaultTaskLimits` 签名相应收（第二参 bash limits 无消费字段即删）。前台
`BashLimits.spillDir` 是另一字段，零变更。

**写形态**：

- **每任务单写队列**：两 pump（stdout/stderr）仅同步入队 chunk，一条 promise 链
  **串行**执行「清洗 → 帽判定 → append → 计数」——到达序由队列单写者保证（双泵
  各自异步 append 的 write(2) 执行序不保证等于提交序；帽判定/计数分散双泵即竞态）；
  flush 保证与写帽收敛均在队列内，队列 drain 先于 finalize（沿现
  `Promise.allSettled(pumps)` 后 finalize 的时序骨架）。
- **ANSI/CR 清洗状态机**（清洗移到写入侧的完整规格，三条）：
  1. 转义序列（ESC 起）可跨 chunk 边界——状态机跨 chunk 保持 in-escape 态；
  2. 裸 `\r` 清洗依赖负向前瞻 `\r(?!\n)`——流式化为**尾部 `\r` 暂存一字符**，待下
     chunk 首字节或 EOF 裁决（防 CRLF 劈 chunk 误删）；
  3. EOF 未终结的转义序列**原样保留**（fail-visible，不静默丢弃）。
- **写帽**：按**字节精确**截断，截断点 UTF-8 续字节（`0b10xxxxxx`）回退对齐（防文件
  尾 U+FFFD）；超帽停止 append、`droppedBytes` 计数、`truncated=true`；文件保留已写
  前缀（spill 机制整个删除——文件形态天然全文在前缀内）。
- **IO 失败路径**（文件是主产物，不静默）：
  - start 期 mkdir 失败 → 判别联合 `{ok:false, reason:"TASK_LOG_DIR_UNWRITABLE: …"}`
    （不打穿 bash 工具执行面）；
  - append 失败 → 队列捕获置 `snapshot.writeError` + stderr 留痕（onWarn 同款），
    终止后续写；通知正文在该场追加注记行（`log incomplete (write error)`）——
    **通知不得声称日志完整**。

**接口面**：

- 删：`read()`/`TaskRead`（含 index.ts 导出与头注释）/headBytes/nextOffset/spillPath/
  spill 写；ChannelCollector 从 tasks.ts 摘除（collect.ts 保留——前台 bash 仍用）；
- `TaskSnapshot`：+`session: SessionId | undefined`（onSettled 路由键）、
  +`logPath: string`、+`droppedBytes: number`、+`writeError: string | undefined`、
  -spillPath；`bytes` = 已写文件字节（清洗后）；`truncated` = 写帽触发；
- `start()` 返回值：`{ id }` → `{ id, logPath }`（返回文案 §2.6 消费）；
- 增：`onSettled(listener: (snapshot: TaskSnapshot) => void): () => void`——
  **finalize 单点发射**（五路终态唯一收口，settled 哨兵防重）；同步发射、
  **登记簿侧 per-listener try/catch**（沿 core emitFrom 先例——单 listener 同步
  throw 不中断其余 listener、不回灌 finalize 链）；listener 异步收敛（tail 读 +
  notify）自担错误（stderr sink）；
- **文件句柄由 finalize 链收口关闭**（evict/stopAll 只杀进程不提前 close——
  pump 队列仍需排空）；
- 不变：start（并发帽/占位/墙钟帽/两段杀）、stop（幂等/两段杀）、evict、stopAll、
  list、状态机、会话键控。

### 2.3 读面围栏：系统固有读根（tool-core）

日志目录在宿主数据目录（工作区外），read/grep 的 PathGate 缺省拒——**不能借
permission extraRootsOf 放行**（那是用户逐会话授权面，语义是「用户批准的额外根」；
系统固有读面混进授权面 = 执法面语义漂移）。落点：

- `ToolPluginInput` 增 `systemRoots?: readonly string[]`（装配期静态根）；
  `tool-plugin.ts` 会话入口合并：`extraRootsOf = (session) => [...systemRoots,
  ...grants.extraRootsOf(session)]`（单点合并，paths.ts admit 逻辑零改动，
  grants 授权/撤销面零污染）；
- 装配：harness `toolboxKit` 参数增 `taskLogDir?: string`，透传 createBashPlugin
  （taskLimits）并作 systemRoots 传 read/grep（bash/write 不传——无文件读面）；
- 宿主：host-hub 装配 toolboxKit 时传 `<hostData>/task-logs`。

**放行域 = 整个 task-logs 子树（含他会话子目录）**，两处交互如实声明：
任务日志是模型产物（命令输出），敏感度低于会话档案，host-hub 单用户形态下无越权
面；**worktree 隔离会话**（rootOverride 在场）的 guard 过滤只作用于 guard 子树内的
extraRoots——task-logs 在 guard 外不被过滤，隔离子代理可读整棵 task-logs。
属完整性低敏面，落档接受；多租户形态出现时再收。

**生命周期（会话档案一致性兑现）**：

- 会话进行中：日志随写随读（模型 read/grep 自由）；
- 停止/超时：文件保留（通知带路径，「结束后可查」成立）；
- **evict（sessionDisposed）不删日志**：parked 会话可复活（SESSION-RESUME），日志
  随档案寿命而非登记簿寿命（登记生命周期=会话生命周期管的是进程，不管磁盘档案）；
- 宿主删除会话：host-hub session-delete 级联清理 `task-logs/<id>/`。**顺序裁决**：
  task-logs vanish **前置于** sessionsRoot vanish——日志清失败 = `io_failed` 整体
  失败可重试（会话目录 rename 是不可回滚段，放最后）；子孙任务日志随 descendantIds
  血缘集同款级联，失败 stderr 留痕（children cascade 同口径，不静默）。两根各自
  rename 各自原子，合并非原子——前置顺序即为此裁决的兑现；
- 装配拆卸/进程退出：文件保留（宿主数据；下次启动 session-delete 仍可清）。

### 2.4 完成通知臂（task-tools 新文件 notify-bash.ts）

**归属**：task-tools——bash 源适配在本包（件14 三次裁决），bash 任务通知同属；
与 agent-delegation 的 notify.ts（agent 源通知）对称成对。

**停靠**：task-tools plugin 双 `ctx.waitFor(agentLoopServiceToken)` +
`ctx.waitFor(backgroundTasks)`——`Promise.all` 合并 + 单 `.then(onOk, onReject)`
（顺序 await 会在首 reject 后把第二 promise 悬空成 unhandled rejection）；reject 口
只吞「等待层 dispose」（沿 bash 源停靠旗先例）；onSettled 退订挂 `ctx.effect`。
均为可选依赖——无 loop 世界/无 bash 世界对应臂不挂，纯工具形态零通知。

**listener**：`tasks.onSettled(snap => …)`——

1. `loop.get(snap.session)` 缺席（匿名/已封存/evict 竞态）→ 丢弃（文件仍在，通知
   非唯一载体）；
2. 读日志尾部：`min(size, 4096)` 字节，**字节切片 + UTF-8 续字节回退对齐**
   （headBytes/tailBytes 先例；不整文件读入内存——64MB 放大不可接受）；
3. `handle.agent.notify("bash-task", "content", text)`——AgentMessageKind="content"
   （同 DELEGATION_REPORT_SOURCE 口径）：next-step 排队 + 唤醒、材料化
   agent/message、UI 不当用户发言、压缩摘要保留（delegation 通知全同款，零新语义）；
   busy 亲会话 = 步边界消费（任务发起 turn 内快速完成也能送达）；多任务同拍 settle
   的 wake 合并为单 kick（driver wakeRequested 既有语义）；
4. 通知丢失败（父恰在封存）→ 丢弃 + stderr 留痕（同 deliver 口径）。

**铸文**（首行对齐 [agent-notification] 家族词面；commandHead 截 80 码点逻辑自
source-bash.ts 上移共享——两文件同源消费）：

```
[task-notification] task t-xxxxxxxxxxxx (<command 截 80 码点>): completed exit=0 bytes=<n>
log: <绝对路径>
--- last <n> bytes ---
<尾部切片>
```

truncated 任务追加 `(output capped at <fullCapBytes> bytes; <droppedBytes> dropped)`；
writeError 任务追加 `log incomplete (write error)`。**全部终态都通知**
（completed/failed/killed/timed-out）——与 agent 源 stop 后通知仍送达同构
（verbs.stop 既有裁决「stop 后通知如实送达」），无特例分支；stop 工具的同步回执
之外多一条 killed 通知是同构成本，落档。

### 2.5 task_stop 保留面

hub/三态路由/probe/stop 链全保留（dev server 停止、子代理取消仍是刚需）。
notFoundText 词表不变（正文未提 task_output）。

### 2.6 文案改写（tool-bash/bash.ts）

- 描述（bash.ts:68）：`run_in_background` 行改为「runs the command detached: it
  keeps running across turns; output appends to a log file (path returned — read or
  grep it for progress); a [task-notification] arrives when it finishes. No \`&\`
  needed.」；
- 返回值（bash.ts:103，消费 start 返回的 logPath）：`Background task <id> started
  (wall clock <ms>ms cap) — output appends to <logPath>; a [task-notification]
  will arrive on completion; stop it with task_stop.`；
- spawn.ts/descriptions.ts（agent-delegation）已无 task_output 提法，零改动。

## 3. 范式修订声明（对件14/件13 的显式推翻）

- 件14 §0「LLM 可见面 = task_output + task_stop 两工具」→ 修订为 task_stop 单工具；
- 件14 §9「本仓无一等文件指针路径，task_output 即一等读面」→ 修订为**日志文件路径
  即一等读面**（上游 Claude Code BashOutput 废弃后同款路线：输出文件 + Read）；
- TASKS.md 正文按本件同改（方案与代码同变：先文档后代码）。

## 4. 测试计划（矩阵）

| 包 | 删除用例 | 新增/改写用例 |
| --- | --- | --- |
| tool-bash tasks.test（service.test 落点） | read/offset/nextOffset/spill 全组 | 文件写入（双泵同拍 chunk 经单写队列串行有序落盘、marker 到场）；写帽（字节精确截断 + UTF-8 续字节对齐 + truncated/droppedBytes + 前缀保留）；ANSI/CR 状态机（转义序列劈 chunk、`\r\n` 劈 chunk、EOF 未终结转义保留）；IO 失败（mkdir 拒 → TASK_LOG_DIR_UNWRITABLE；append 失败 → writeError + 通知注记）；onSettled 五路终态恰好一次（有界 poll 收证——沿 waitSettled 装置，禁固定 sleep）+ settled 哨兵防重 + per-listener throw 隔离；队列 drain 先于 finalize（订阅者读无撕裂尾）；匿名 `_anon` 桶路径；sessionKey 词表安全 |
| tool-bash service.test（装配） | spill 装配用例（如有） | taskLogDir 缺省 mkdtemp / 显式传参两形态；外穿 tasks 实例 + taskLimits 互斥仍 fail-fast |
| tool-core tool-plugin.test | — | systemRoots 合并（静态根 ∪ 授权根；缺省空数组=现行为不变）；read/grep 经 systemRoots 放行日志路径、bash/write 不受影响 |
| task-tools routing.test | output 路由组（三态 output 分支、block 归一化、迟到 miss output 用例） | stop 路由组全保留平移 + **补 stop 侧源异常隔离与 stop 迟到 miss 用例**（output 组删除后该两分支失去覆盖） |
| task-tools source-bash.test | 「bash task source output」组、bashReadText 组 | stop/probe 组平移 |
| task-tools plugin.test | — | 「registers exactly task_output/task_stop」改单工具断言；docking/end-to-end/without-bashTasks 用例**改用 task_stop 载体**（docking 语义是保留面，改载体不删用例） |
| task-tools descriptions.test | TASK_OUTPUT 锚词组 | 参数 parity 组改 task_stop 单工具解构 |
| task-tools notify-bash.test（新） | — | 铸文（首行词面/bytes/路径行/尾部切片/truncated 与 writeError 注记）；tail UTF-8 字节对齐（多字节字符劈尾）；loop 缺席丢弃；notify throw 丢弃 + stderr；忙会话步边界排队（材料化 agent/message 断言）；「无 loop 世界不挂臂」为弱断言（settle 后无 throw/无 stderr——负面无观察通道，命名如实） |
| agent-delegation | nameaddr/delegation/notify-path 中 output 段、X11 cap 截断用例、report-delivery 的「task_output 全文兜底」用例整删 | report-delivery「通知直送全文」改写为纯通知断言保留；文件头注释重写；spawn/message/list_agents/stop 通知路径全绿（删除不伤保留面） |
| harness kits.test | — | 工具清单去 task_output；toolboxKit taskLogDir 透传 |
| apps/cli resolve-agent-options.test | — | REGISTERED 与 --exclude-tools 期望清单去 task_output |
| e2e toolbox-journey | task_output 调度段 | run_in_background 返回含 log 路径；read 工具（真实调度）读到 marker；**通知等待装置：二次 whenIdle()（通知唤醒的新 turn 收轮后）或 WAL 有界轮询（`agent/message{source:"bash-task"}` 帧出现为谓词）**——一次 whenIdle 后立即断言必 flaky；脚本数组为通知 turn 预留额外 script；task_stop 收敛不变 |

每个「删除后无替代」的显式行为（agent 运行中窥视）在 AGENT-DELEGATION.md 落注，
不写回归用例（无面可测）。

## 5. 实施顺序（每步四门绿）

- **A. tool-bash**：登记簿文件化（单写队列/ANSI 状态机/写帽/IO 失败面）+ onSettled +
  taskLogDir 配置 + TaskLimits 收窄 + 描述/返回值改写（task_output 尚在——其 bash
  源 output 读面暂打空，**A+B 同一批次落地**，不单独作为可发布态）；
- **B. task-tools + tool-core**：TaskSource 接口收窄 + task_output 删除 + systemRoots
  合并 + notify-bash 通知臂（双停靠 Promise.all + effect 退订）；
- **C. agent-delegation**：output/reportText/raceIdle 删 + reportDelivered 死链清 +
  task-source output 删；
- **D. harness + apps + e2e + 文档**：toolboxKit 透传、kits.test、apps/cli 期望清单、
  toolbox-journey 改写（含通知等待装置）、host-hub session-delete 级联清理（顺序
  前置裁决）+ 装配传参 + `session-delete.ts:43` 注释清理、TASKS/AGENT-DELEGATION/
  TOOLBOX/AGENT-MESSAGE/SUBAGENT-FAILURE-NOTIFICATION/CLI/TODO/PLUGIN-AUTHORING
  文档同变（§6）。

批次 AB/C/D 各自可回滚；提交信息引用本文件节号。

## 6. 文档同变清单

- docs/TASKS.md：终态节按 §3 修订；§1.1/§1.2 工具面表删 task_output 行；
- docs/AGENT-DELEGATION.md：§5.1「模型不需要再调 task_output 取报告」提法、
  §4.4/§5.2 task_output/task_stop 提法、reportDelivered 相关注记；
- docs/TOOLBOX.md：§4 登记簿形态（内存缓冲/spill → 文件 + onSettled + taskLogDir）；
- docs/AGENT-MESSAGE.md：内部消息源清单增 `bash-task`；§90 迁移地图行
  「reportDelivered/复查不复读」提法清理；
- docs/SUBAGENT-FAILURE-NOTIFICATION.md:61「task_output 同口径：reportText 失败
  路径」提法更新（reportText 已删）；
- docs/CLI.md:351 验收清单行（工具面清单去 task_output）；
- docs/TODO.md 三处 task_output 参照提法（现行参照非历史节，随实同变）；
- docs/PLUGIN-AUTHORING.md:53-54「已知来源登记（纯文档）」表补 `bash-task` 行
  （AGENT-MESSAGE.md 明文该表是登记落点）；
- docs/PERMISSION-V2-DESIGN.md：核实后按需加注（systemRoots 是装配面不是授权面）。

## 7. 对抗审查关注点（已处置，见 §10）

read/grep 放行域与 worktree 隔离交互（§2.3）；单写队列与 flush（§2.2）；
onSettled 隔离与停靠时序（§2.2/§2.4）；通知风暴量级（§9）；evict 不删日志的口径
张力（§2.3）；e2e 等待装置（§4）。

## 8. 残余缺口与边界（如实声明，不阻断）

| 边界 | 说明 |
| --- | --- |
| agent 运行中窥视无面 | 反轮询范式内行为；中途要信息走 agent_message |
| 匿名会话无通知 | loop.get(undefined) 无句柄；文件路径仍在返回值，裸 SDK 世界 read 亦不可达（tmpdir 在围栏外）→ 通知尾部切片是唯一面 |
| 裸 SDK 世界（未配 taskLogDir） | 日志进进程临时目录：通知可送达（若装配 loop）、文件不可 read；落档装配纪律 |
| 通知丢失败窗口 | 父恰在封存（同 delegation 现状）；emitFinished 同口径仍发射 |
| busy 会话通知排队 | next-step 步边界消费——与 delegation 报告同语义（已验证先例） |
| read 工具读日志的能力边缘 | ① 首 8KB 含 NUL 判 binary 拒读（输出二进制字节的命令日志不可 read）；② read 是行窗（2000 行/50KB）非字节偏移，读大日志尾部需两跳（先拿 totalLines 页脚再 offset）；③ 「天然支持 offset/tail」按此能力口径理解 |
| 进程退出撕裂尾 | worker 退役=进程退出时 finalize 链被截断：日志尾部可能残缺、通知不来——可接受面（文件已写部分仍在盘） |
| 日志完整性（非机密性） | `exec:"direct"` 任务可写任意路径含自己的日志（路径在模型上下文）；SDK 缺省 taskLogDir 在 tmpdir（fence writable 恒含）→ contained 任务亦可写。均为完整性面非机密性面，接受 |

## 9. 不处理落档

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 任务枚举/清单工具、跨源统一 id、任务持久化、remote 源 | 沿件14 §9 不变 | — |
| 通知频控/合并 | 后台任务模型显式发起 + 每会话并发帽 3；最坏量级 = 每通知一次 LLM turn + WAL 两事件 + 4KB 尾部，自激励循环（完成→唤醒→再起任务）无总量帽——先观察 | 后续件 |
| 日志文件轮转（单文件超帽截断而非轮转） | 写帽已界定量级；轮转破坏「单文件单偏移」简单性 | 后续件 |
| 前台 bash spill 目录统一 | 前台 spill（截断时落盘）与本件 taskLogDir 是两个关注点；前台行为零变更 | 后续件 |
| task-logs 目录 tmp-sweep 式残迹回收 | session-delete 级联已覆盖正途（失败留痕可重试）；孤儿目录（崩溃残迹）沿宿主 tmp-sweep 先例后续并轨 | 后续件 |

## 10. 对抗审查处置（两路并行，28 项全处置，2026-09-24）

**路A（契约/语义，10 P1 + 10 P2）**：P1-1 TaskSnapshot 缺 session → **采纳**（§2.2
接口面 +session；与路B P1-2 合并）。P1-2 TaskLimits.maxOutputBytes/spillDir 零消费
残留 → **采纳**（§2.2 TaskLimits 收窄节）。P1-3 start 返回形状未列 → **采纳**
（§2.2 接口面 +logPath）。P1-4 ANSI 漏裸 `\r` lookahead → **采纳**（§2.2 状态机
规格三条之 2；与路B P1-4 合并）。P1-5 尾部切片「代理对」措辞错位 → **采纳**（§2.4
步骤 2 改「字节切片 + UTF-8 续字节回退」，删 UTF-16 码点错引）。P1-6 task-tools
测试矩阵漏 source-bash.test/plugin.test/descriptions.test 三文件 → **采纳**（§4
矩阵逐文件补；plugin.test docking 用例改 task_stop 载体保留语义验证）。P1-7 apps/cli
REGISTERED 清单漏 → **采纳**（§4 矩阵 + §5 D 步）。P1-8 route() 异常隔离/迟到 miss
失覆盖 → **采纳**（§4 补 stop 侧两用例）。P1-9 文档同变漏四文档+登记表 → **采纳**
（§6 补 SUBAGENT-FAILURE-NOTIFICATION/CLI/TODO/PLUGIN-AUTHORING/AGENT-MESSAGE
迁移地图行）。P1-10 worktree 隔离 × systemRoots 交互未声明 → **采纳**（§2.3 放行
域节显式声明）。P2-11 raceIdle 死代码 → **采纳**（§2.1 删除清单）。P2-12 头注释
语义清理超 grep 锚 → **采纳**（§2.1 注记「grep 锚是验收下界」）。P2-13 TaskRead
导出/头注释 → **采纳**（grep 锚补 TaskRead/bashReadText）。P2-14 session-delete.ts:43
注释清理列入 D 步 → **采纳**（§5 D）。P2-15 通知缺 bytes → **采纳**（§2.4 铸文
+bytes=，与 stateLine 同口径）。P2-16 commandHead 共享 → **采纳**（§2.4 上移共享）。
P2-17 read 工具三边缘未声明 → **采纳**（§8 边界表）。P2-18 tool-bash plugin.test
不存在 → **采纳**（落点改 service.test）。P2-19 report-delivery.test 处置粒度 →
**采纳**（§4 细化）。P2-20 写帽字节精确/UTF-8 对齐 → **采纳**（§2.2 写帽节）。

**路B（架构/并发/生命周期/假绿，1 P0 + 5 P1 + 6 P2）**：P0-1 双泵异步 append 无
串行化保证 + 测试矩阵假绿掩盖 → **采纳**（§2.2 写形态头条改「每任务单写队列」：
同步入队 + promise 链串行 清洗→帽判定→append→计数；§4 矩阵「双泵同拍 chunk 串行
有序落盘」用例）。P1-2 快照/返回值缺 session/logPath → 与路A P1-1/P1-3 合并处置。
P1-3 IO 失败静默产谎通知 → **采纳**（§2.2 IO 失败路径：TASK_LOG_DIR_UNWRITABLE
判别联合 + writeError 快照标记 + 通知注记「log incomplete」）。P1-4 CR lookahead
流式化 → 与路A P1-4 合并（状态机 2/3 条：CR 暂存 + EOF 未终结保留）。P1-5 e2e
一次 whenIdle 即断言必 flaky → **采纳**（§4 e2e 行：二次 whenIdle 或 WAL 有界轮询
谓词 + 脚本预留通知 turn）。P1-6 跨根删除非原子/顺序未裁决 → **采纳**（§2.3
顺序裁决：task-logs vanish 前置，失败 io_failed 可重试，不可回滚段最后）。
P2-7 onSettled per-listener 隔离 → **采纳**（§2.2 emitFrom 先例）。P2-8 双 waitFor
reject 悬空 + 退订面 → **采纳**（§2.4 Promise.all + 单 then + ctx.effect）。
P2-9 句柄关闭责任 + 进程退出撕裂尾 → **采纳**（§2.2 finalize 链收口；§8 边界表）。
P2-10 自激励循环最坏量级 → **采纳**（§9 频控行补注）。P2-11 direct/tmpdir 完整性
面 → **采纳**（§8 边界表）。P2-12 弱断言命名 + 禁固定 sleep → **采纳**（§4
notify-bash/plugin 两行注记）。

**两路一致核过无偏面**：依赖无环（task-tools→agent-loop 经 waitFor 软依赖）；
grants 授权面零污染；多任务同拍 settle 的 wake 合并；contained 任务/rg 读 task-logs
可达性；session-delete 与在写窗口无主路径竞态；`_anon` 与 isSafeSessionId 零碰撞；
notify 自由 source 词面支持；tasks.read 无包外消费者；spawn 文案零改动。
