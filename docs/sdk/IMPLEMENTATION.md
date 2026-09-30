# IMPLEMENTATION — x-harness Agent SDK 施工图

状态：定稿（盘点已完成：主会话读码 + 独立盘点 agent 交叉验证）
上游文档：docs/sdk/DESIGN.md

## 1. 存量审计（已完成）

审计范围：apps/host-hub/src/{host,worker,shared,protocol}、apps/cli/src、packages/e2e
相关夹具。四条标准：正确性 / 契约符合 / 实现质量 / 依赖方向。

### 1.1 结构事实（盘点定稿）

- 分发链：host.ts:213 commands.handle → 未处理者 pool.routeLine（host-commands.ts:404
  handle 四级：permissionDual → handlers → PARKED_DIRECT → 透传）；worker 侧
  worker-commands.ts:244 注册表分发；prompt/compact 先试 slash 注册表分发
  （worker-commands.ts:151-190）。
- 词表三副本：commands.ts:53（82 闭集，isKnownCommand 死导出仅测试消费）、
  internal.ts 四集合（真正运行时词表）、remote-protocol/vocab.ts:3（62 子集）
  + fanout.ts:33 事件名副本。
- 事件翻译：event-bridge.ts:84（wire 事件名 = 平台 token 字面量透传 + settled/
  llm/chunk/bash_execution_update 合成 + 25ms 节流 + agentName 子代理归属）。
- 生命周期：pool beginThread(@pending 槽)/beginKnown/wake(12 次重试)/retireThread/
  shutdownAll/releaseSlotDebts；worker thread-commands serializedLifecycle；
  sweep（idle/rss/stale，keepalive 豁免）；hub-gateway HostAttach 第三套监督（不迁）。
- 目录：X_HARNESS_HOME 三处独立解析；agentDir 仅 hub 概念；taskLogsRootOf 唯一共享。
- 测试：host-hub 63 文件（kit 夹具 host-client/worker-harness/pool-fixture）；
  cli 25 文件；e2e 15 旅程（不含 host-hub 进程级旅程，其验收在自身 __test__）。
- 覆盖率排除 `**/src/**/worker/**`：SDK 新包路径不得新增等价排除（DESIGN Q5）。

### 1.2 组装差异表（AD1：sdk/assembly.ts 必须容纳的自由度）

| 维度 | cli build-world | hub assembly | SDK 装配字段 |
| --- | --- | --- | --- |
| session 持久化 | persist 开关（inline/durable） | 恒 durable | persistence: "durable"\|"inline"（inline 时无 taskLogDir） |
| providers 配置 | ~/.x-harness/providers.json，apiKey 内联必填，无 preset；per-provider apiKey override | agentDir/providers.json，preset+apiKeyEnv+credentials.json(0600)+modelOverrides | hub 格式单源 + apiKey 一次性注入位 + per-provider override（B#11/A#7，MIGRATION §4） |
| adapter 来源 | providers.json + resolution | WorkerCatalog env 快照 + script adapter | client 级 catalog 快照（K9）+ 可选 scriptAdapter |
| skill 插件 | harness.skillKit（无 disabled 集） | skill.createSkillPlugin（disabled 集） | hub 侧单源（含 disabled）；cli 差异面収进（A#3a） |
| delegation | delegationKit（home 目录，无 builtin，worktree 打包） | createAgentDelegationPlugin（builtin+provider 解析+agentDir） | hub 语义单源；worktree 分开装配保持（A#3b） |
| 工具限制 | --tools/--exclude-tools/--noTools → registry.scoped().restrict | 无 | startThread 装配字段 tools/excludeTools（A#3c） |
| 系统提示追加 | --append-system-prompts 段落 | 无 | systemPromptAppend（A#3c） |
| retry 表 | per-provider retry 表 + default | 单 default | per-provider + default 全集（A#3c） |
| taskLogDir | persist 时挂，inline 无 | 恒挂 | 随 persistence 开关同律（A#3c） |
| 命令面/todo | 无 | commandsPlugin + todo + 外部插件 | 开关（默认全开，cli 可关） |
| 权限 broker | 终端问答（无超时） | ui_request confirm（300s 超时） | confirm 回调注入 + confirmTimeoutMs（0=无超时，A#5） |
| 权限缺省 | sandboxed-auto（显式） | settings 链，缺省 auto | settings 链单源，缺省 auto（B#15） |
| 保护目录 | rgBinDir | settings/plugins/bin | 并集（B#16） |
| 遥测/rg 根 | home/ | agentDir/ | agentDir 单根；telemetryResourceName 可配（B#16） |
| dial 持久化 | reopen 传 options（重启丢） | session/meta WAL + dialHook 折叠（重启保留） | WAL 折叠单源（行为变化 C7 登记，A#6） |
| compaction | triggerPct/autocompact:false，summarizer 带窗口 | 恒 autoCompact，summarizer {model,provider} | compaction 字段全集（B#14） |
| mailbox/workflow 根 | env/home 回退 | env/home 回退 | client 显式注入，缺省 agentDir 派生（B#12） |
| plugin-propose/外部插件 | 无 | proposal + vendor + audit | 默认开，cli 可关（B#17） |

### 重复清单（提取计划）

| # | 重复事实 | 位置 | 提取目标 |
| --- | --- | --- | --- |
| D1 | agent 组装（19 个共有 kit + RETRY_POLICY 字面量两份） | cli/build-world.ts vs hub assembly.ts | sdk/assembly.ts（hub 主体 + cli 差异面可选） |
| D2 | 生命周期 create/resume + dispose | cli run-repl makeNext/reopen vs hub pool + thread-commands | sdk/client.ts 生命周期面 |
| D3 | 事件翻译/消费 | hub event-bridge vs cli render-stream（同名事件两套包装） | sdk/events.ts 单源 |
| D4 | 词表三副本 | commands.ts / internal.ts / remote vocab | sdk/vocab.ts 单源（remote 副本挂账） |
| D5 | 目录解析 | X_HARNESS_HOME 三处 + agentDir 仅 hub | sdk 装配注入显式路径 |
| D6 | 命令分发骨架 | host.ts 与 worker.ts 两个 stdin 循环 | sdk executor + 传输适配 |
| D7 | 第三套监督 | hub-gateway HostAttach | 不迁（对接面不变，挂账） |

## 2. 逐模块裁决表（定稿）

| 旧文件 | 裁决 | 去向 | 备注 |
| --- | --- | --- | --- |
| host-hub/src/host/worker-pool.ts | 重构 | sdk/client.ts + sdk/executor-worker.ts | 状态机上移 client，spawn/relay 留 worker 执行器 |
| host-hub/src/host/worker-process.ts | 复制 | sdk/executor-worker/spawn.ts | WorkerHandle 接口原样 |
| host-hub/src/host/worker-control.ts | 重构 | sdk/client.ts | 控制帧路由并入生命周期 |
| host-hub/src/host/worker-frames.ts | 复制 | sdk/executor-worker/relay.ts | 帧中继原样 |
| host-hub/src/host/thread-table.ts | 复制 | sdk/thread-table.ts | 单一真相 |
| host-hub/src/host/route-gates.ts | 复制 | sdk/route-gates.ts | |
| host-hub/src/host/thread-retire.ts（sweep） | 复制 | sdk/sweep.ts | idle/rss/stale 同律，双执行器共用 |
| host-hub/src/host/host-commands.ts | 重构 | sdk/commands/host-admin.ts + host-hub 薄壳 | 管理命令下沉，stdio 响应留壳 |
| host-hub/src/host/admin-commands.ts | 重构 | sdk/commands/admin/ 按域拆：settings/skills/plugins/agents/models/permission-dual | 审查 B#6 |
| host-hub/src/host/models-admin.ts、models-auth.ts、credentials.ts | 重构 | sdk/catalog/ | catalog+credentials 快照单源（K9） |
| host-hub/src/host/agents-admin.ts、skills-admin.ts、skills-install.ts、plugins-admin.ts、plugins-install.ts、skills-migrate.ts、agents-migrate.ts | 重构 | sdk/commands/admin/ 对应域文件 | 逐文件迁移 |
| host-hub/src/host/session-delete.ts | 复制 | sdk/commands/session-delete.ts | 级联子会话/task-logs/telemetry/trash 原样 |
| host-hub/src/host/git-watch.ts | 复制 | sdk/git-watch.ts | 双执行器共用（审查 B#1） |
| host-hub/src/host/telemetry-purge.ts、tmp-sweep.ts、saved-query.ts、trust-store.ts | 复制 | sdk/ 对应文件 | 各自独立文件 |
| host-hub/src/host/read-history.ts、parked-reads.ts | 复制 | sdk/commands/ | 直读（session-delete 已单列） |
| host-hub/src/worker/worker.ts | 重构 | sdk/worker-entry.ts | 传输无关化（input/writer 抽象已有） |
| host-hub/src/worker/worker-commands.ts 家族（7 文件） | 重构 | sdk/commands/*.ts | respond 目标抽象化（帧→SdkResult） |
| host-hub/src/worker/event-bridge.ts | 重构 | sdk/events.ts | 发射目标抽象化 |
| host-hub/src/worker/assembly.ts | 重构 | sdk/assembly.ts | hub 主体 + cli 差异面（AD1） |
| host-hub/src/worker/dialogs.ts、inflight.ts、bash-exec.ts、meta-state.ts、thread-commands.ts、catalog-reload.ts、plugins-hot.ts、external-plugins.ts | 复制/重构 | sdk/ | 命令域文件按域归位 |
| host-hub/src/shared/*（18 文件） | 复制/归并 | sdk/ | limits/errors/frames/jsonl/images 等单源 |
| host-hub/src/protocol/* | 重构 | sdk/vocab.ts + sdk/frames.ts | 词表+派生集合单源；isKnownCommand 删除 |
| cli/src/build-world.ts | 重构 | 删除，cli 依赖 sdk/assembly.ts | AD1 差异面吸收 |
| cli/src/run-repl.ts makeNext/reopen | 重构 | sdk/client.ts resumeThread/startThread | REPL 保留，调 SDK |
| cli/src/slash-commands.ts、render-stream.ts、repl-terminal.ts | 保留 | cli | UI 层不动 |
| cli/src/run-print-mode.ts | 重构 | 调 sdk | print 模式走 SDK |
| e2e 既有 journey | 保留 | packages/e2e | 新增 sdk-journey |
| hub-gateway HostAttach / remote vocab | 不移植 | 原地 | 对接面不变；词表收敛挂账（DESIGN Q4） |

## 3. 分阶段实施（每阶段：实现 → 四门 → 双子 agent 对抗审 → 修复回审清零 → 提交）

切分原则：每阶段结束即「单一消费者切换 + 旧实现即时删除」，不允许两份实现
并存跨阶段；阶段间加帧级对拍收口提交。

- **P0 试运行切片**（进行中）：sdk 包骨架（vocab/limits/errors/thread-table/
  events/client）+ **帧字节快照测试**（A#16/K11：现存帧样本逐字节锁定，含
  frame-classify/SETTLED_HEAD 正则、responseLine 键序、agentName 尾置、
  uiRequestFrame 摊平、心跳双形态）+ in-process 执行器最小面 + 假 LLM 注入位
  + 单测 + e2e sdk-journey。本阶段不删旧代码。
- **P1 命令面全量**：worker-commands 家族下沉为 sdk/commands/*——**响应抽象
  双宿主先行**（A#18：命令处理器=纯函数输入→结果+控制事实，配最小 worker
  假身契约测试，控制响应可被 client 截获触发 rebind/rekey）；admin 域下沉
  （含 permission 双路由/catalog 快照 K9）；对应域测试同阶段迁移。
  **阶段末：host-hub worker 重新指向 sdk/commands，删本地副本。**
- **P2 worker 执行器**：executor-worker + worker-entry（spawn/relay/握手/心跳/
  park/wake/requeue/pendingCommands/sweep）；exec 解析注入 + host-hub 自托管 +
  dist 产物（/$bunfs/ 分支）三项冒烟（A#21）；worker 侧文件覆盖策略 =
  in-proc harness（input/writerOverride）+ spawnOverride（A#22/23）。
  **阶段末：host 层切 executor-worker（删 worker-pool/worker-control/
  worker-frames/worker-process），帧级 e2e 对拍 + 语义迁移全绿收口。**
- **P3 host-hub 薄壳化**：host.ts = SdkClient(worker)+帧适配；删剩余旧实现
  （host-commands 主体/route-gates/git-watch 下沉件）；stdio 帧回归落薄壳
  __test__（真进程夹具形态，A#20）；帧格式零变化回归。
- **P4 cli 切换**：cli 改用 sdk in-process（build-world 删除；run-repl 生命
  周期切 SDK，slash 依赖面按 MIGRATION §5 对照表核销）；providers.json 一次
  性迁移（MIGRATION §4）；e2e cli-journey 回归。
- **P5 收口**：覆盖率 ≥ 门禁、双形态冒烟、假绿对抗抽查、验收清单核销。

## 3b. 测试夹具归属（A#19）

| 夹具 | 去向 |
| --- | --- |
| __test__/kit/host-client（真进程） | host-hub 薄壳 __test__（stdio 回归主体） |
| __test__/kit/worker-harness（FakeInput+captureWriter） | packages/agent-sdk/src/__test__/kit（双宿主命令测试主体） |
| __test__/kit/pool-fixture（fakeSpawn） | packages/agent-sdk/src/__test__/kit（executor-worker 测试） |
| coverage-final/stdout-guard/smoke-dist | 随所测能力迁 sdk 或留壳（逐文件标注） |

迁移矩阵（MIGRATION §2）按此表逐文件展开，禁止跨包引用别包 __test__ 私有文件。

实施纪律：每阶段独立提交引用本文件节号；实现推翻方案时同一提交先改文档。

## 3c. P0 实施偏差登记（与 DESIGN/API 的差异，随 P1 收敛）

- events AsyncIterable 有界面（birth 缓冲 + 背压）随 P1 实现——P0 事件面为
  onEvent/thread.on 直通（无缓冲无界问题已消除）；
- runCommand/slash 分发面随 P1 命令面（句柄不暴露 runCommand，非静默吞）；
- client.shutdown 接执行器接线随 P1（executor.shutdownAll 已实现，client 侧
  注册回执待接）；abort 完整取消链（bash/broker/inflight/delegation 四步）
  随 P1 对应域下沉；
- startThread 仅支持 cwd/trusted/dial（其余 API 字段随 P1 装配全量落地，
  未实现字段不声明不吞）；
- helloFrame 常量与 vocab 单源合并、hub 帧交叉断言随 P2 worker 执行器。

## 4. 测试计划（口径先行）

- 契约级：错误码封闭（导出 == 文档）、事件词表封闭、命令词表闭集与派生集合
  包含关系（移植 contracts-frames）、状态机迁移表驱动、settled 恰好一次、
  already_open（含持有者等待环）、resume 可唤醒 parked/dead。
- 边界：垃圾输入（非法 threadId/超长/空）、images 上限、abort 全路径、
  shutdown 竞态、wake 重入、pendingCommands 上限、slash 分发管道（/ 前缀先命令后消息）。
- 表驱动：错误码表、命令参数矩阵、限额 clamp 表。
- 回归：host-hub 63 文件/cli 25 文件语义迁移矩阵（MIGRATION.md）；每 bug 用例注明症状。
- e2e：sdk-journey（新）+ 既有 journey 回归 + 双形态冒烟。

## 5. 工具与门禁

四门命令不变（root package.json）。新增包 packages/agent-sdk 进 workspaces；
覆盖率门禁沿用全局（行/语句/函数 ≥90、分支 ≥85）；vitest include 已覆盖
packages/*/src/**/__test__，无需改配置；不得新增覆盖率排除。
