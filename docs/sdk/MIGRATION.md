# MIGRATION — host-hub/cli → agent-sdk 迁移矩阵

状态：定稿（随 IMPLEMENTATION 裁决定稿；行为基线来自盘点交叉验证）
上游文档：docs/sdk/DESIGN.md、docs/sdk/IMPLEMENTATION.md

## 1. 行为规格基线（不变量——迁移后必须逐条成立）

以下行为以现有实现为唯一规格，SDK 化后不得漂移（每条对应既有测试或 e2e 断言）：

| # | 不变量 | 旧锚点 |
| --- | --- | --- |
| I1 | 同 sessionPath 同时只允许一个活线程（already_open） | host-commands.ts reserveResumeSlot / thread-table occupiedPaths |
| I2 | thread/stop 后线程从表移除；retire 后 parked（sessionPath 存在）或 dead | worker-pool settleThreadOutcome |
| I3 | settled 事件每 sendId 恰好一次，必为该 send 的最后一个事件 | event-bridge emitInternalSettled / worker-commands settleAfter |
| I4 | worker 死亡时：pending 命令逐个失败（worker died）、driving send 发 settled ok=false worker-died、resumeWaiter 拒绝 | worker-pool releaseSlotDebts |
| I5 | retired/parked 线程的命令可直读会话历史（parked reads），活线程命令透传 | host-commands parked-reads |
| I6 | 帧协议零变化：response/event/ui_request/heartbeat/thread_died/thread_parked/hub_error 字段与序列化字节级兼容 | protocol/frames.ts + 既有 e2e |
| I7 | resume 重试至多 12 次、每次间隔 1s；spawn 超时 10s | worker-pool wakeOnce |
| I8 | 限额 clamp：idle 0（关）或 [1s,24h]（现状无 0 分支——实现变更点，随 C9）、rss [256MB,2TB] 或 0、maxThreads ≥1；keepalive 线程豁免 idle 退休 | shared/limits.ts + thread-retire.ts:34-41 |
| I9 | in-process 多实例互不串扰（会话根/agentDir/env/mailbox/workflow/事件流隔离）；不注册进程级钩子、不裸读 process.env | 新增（服务端多住户前提） |
| I10 | abort 后 settled(ok=false) 必达；shutdown 时 client 对全部未决 sendId 合成 settled（唯一兜底，含 worker 先退帧未写出情形） | worker.ts shutdown + A#17 |
| I11 | fork/clone 后旧 threadId 命令拒 thread_superseded，新 id 生效；thread_rekeyed 事件必发 | worker-control.ts:80-101 |
| I12 | retire 三态：ok / not-persisted(state_conflict) / in-flight(thread_not_live) | worker-pool.ts:424-458 |
| I13 | in-process 线程故障不外溢：未捕获异常 → 线程 dead + 债务结算（同 I4） | 新增（K6） |
| I14 | platform 事件透传字节同构（name+payload+agentName）；stream/tool_stream 带 owner 归属（与 wire session 键对应）；错误码 26 项全集不变；sendId="" 内部 settled 帧保留 | event-bridge.ts + A#14/复核#1 |
| I15 | stream 事件保留原帧（phase start/chunk/end），cli 渲染依赖不破 | render-stream.ts + A#1 |
| I16 | send/steer/followup 三入口不折叠：运行中 prompt 无排队语义时报 streaming_window（现状保留） | worker-commands.ts:209-233 + A#28 |
| I17 | 排队 send 各自结算：绑定触发其回合的 turn/start seq，不与前一回合 idle 混算 | A#13 |

## 2. 迁移单元与测试矩阵

| 单元 | 旧测试 | 处置 | 新锚点 |
| --- | --- | --- | --- |
| thread-table | host-hub __test__ | 移植 | packages/agent-sdk/__test__ |
| worker-pool 生命周期 | host-hub __test__ | 改写（spawn 替身不变） | sdk client+executor-worker __test__ |
| worker 命令面 | host-hub __test__ | 语义迁移 | sdk/commands/__test__ |
| event-bridge | host-hub __test__ | 语义迁移 | sdk/events __test__ |
| assembly | host-hub __test__ | 合并（cli+hub 并集） | sdk/assembly __test__ |
| host stdio 帧协议 | host-hub __test__ + e2e | 保留断言值零漂移 | host-hub 薄壳 __test__ |
| cli REPL/print | cli __test__ + e2e cli-journey | 保留语义 | cli（调 sdk）__test__ |
| limits/errors/frames | host-hub __test__ | 移植 | sdk __test__ |

## 3. API 新旧对照（消费方视角）

| 旧调用 | 新调用 |
| --- | --- |
| spawn host-hub 进程 + stdin 写 `{"type":"thread/start",…}` | `sdk.startThread({...})` |
| `{"type":"prompt","threadId",…}` + 等 response/settled | `thread.send(text)` |
| `{"type":"thread/resume",…}` | `sdk.resumeThread({ threadId })` |
| `{"type":"thread/stop" / "thread/retire"}` | `thread.stop()` / `thread.retire()` |
| host 帧 event 流（JSONL 行） | `sdk.onEvent` / `thread.events`（SdkEvent） |
| host 帧 ui_request + ui_response | `SdkEvent ui_request.respond(data)` |
| cli buildWorld + loop.create/resume | `sdk.startThread` / `sdk.resumeThread` |
| cli slash `/compact` 等 | 保留 cli UI，动作改走 `thread.command()` |
| get_commands → runCommand | `thread.runCommand("/skill …")` |

## 4. providers.json 迁移单元（审查 B#11，P4 执行）

cli 现状 ~/.x-harness/providers.json（apiKey 内联、无 preset）与 SDK 单源
（agentDir/providers.json，hub 格式：preset+apiKeyEnv+credentials.json）冲突。
P4 切换时一次性迁移：cli 启动检测旧格式 → 转写为 hub 格式（apiKey 入
credentials.json，0600）→ 旧文件删除（不留别名）；--api-key 一次性密钥走
startThread 注入位不落盘。迁移逻辑进 sdk（其他消费方可能週到同样的旧格式），
回归用例注明症状。

## 5. cli 行为变化清单（P4 切换时逐条核销，审查 B#18）

| # | 变化 | 处置 |
| --- | --- |
| C1 | 事件源从 ctx 直订阅改为 SdkEvent（stream 保留原帧，phase 依赖不破） | render-stream 适配层重写，25 文件测试随迁（A#1） |
| C2 | 工具限制 flag | 装配字段 tools/excludeTools 保留语义（B#18①） |
| C3 | --append-system-prompts | 装配字段 systemPromptAppend 保留（②） |
| C4 | /export、会话前缀切换 | cli 侧实现（SDK 提供 listSavedSessions/deleteSession 原语）（③） |
| C5 | inline 模式 sessionsRoot | 仍必填（inline 时指向临时目录），文档明文（④） |
| C6 | print 模式退出码/信号 | main.ts 保留 cli 侧信号语义，SDK 不碰进程信号（⑤） |
| C7 | 换模型持久化：reopen 传参（重启丢）→ WAL 折叠（重启保留） | 行为增益，有意变更（A#6） |
| C8 | plugin-propose/外部插件面 | 新增，默认开，cli 可关 |
| C9 | idle 退休：交互 REPL 默认 idleRetireMs=0（关） | 避免交互形态被 park（A#11） |
| C10 | 子代理类型来源 | builtin+用户+项目（增益，可接受；原 C7 重编号） |

## 5b. slash 依赖面对照（A#4）

| slash | 依赖 | SDK 承载 |
| --- | --- | --- |
| /compact | world.ctx.use(compactionRunner) | thread.command("compact") |
| /export | world.store | sdk.exportSession |
| /resume | world.archive.listHeaders | sdk.listSavedSessions |
| /workflow | workflowView/task_stop | thread.command(workflow/*) |
| /plan | planControl | thread.command(permission/set_mode) |
| /model /thinking | reopen + options | thread.command(set_model/set_thinking_level)（WAL 持久化，C7） |
| /help /quit /clear | 无 world 依赖 | cli 侧保留 |

## 6. 回滚与验收

- 回滚：阶段内可回退；阶段收口提交（切换+删除）是原子步，之后回退 = revert 该提交；
  P1/P2 末的帧级对拍收口提交是安全检查点；
- 验收清单：
  - [ ] I1–I17 全部成立（逐条测试锚点）
  - [ ] host-hub stdio e2e 帧字节级回归通过
  - [ ] cli e2e journey 通过
  - [ ] sdk-journey（in-process）+ worker 模式冒烟通过
  - [ ] 覆盖率 ≥ 门禁，数字如实报告
  - [ ] 无兼容层残留（grep 旧路径/双轨字段为零）
  - [ ] cli 行为变化清单 C1–C10 逐条核销（§5）
  - [ ] providers.json 迁移回归通过（§4）
  - [ ] 假绿对抗抽查通过（无 skip/断言削弱）
