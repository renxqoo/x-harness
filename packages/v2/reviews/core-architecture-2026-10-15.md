# 企业 Agent 底座架构对抗审查

结论：保留纯插件宿主的架构方向。公开机制已经能够组合独立实例、策略判断、请求恢复、外部记录和消费方资源；当前实现的工作收敛、装配事务、能力撤销和定义留存仍违反自身不变量，不能作为已完成企业生产验收的内核交付。

本轮由三个独立子 agent 在三个物理隔离 worktree 中审查和编写测试。主审查者复跑全部新增测试、检查测试断言与 GC 对照，并比较源码与门禁配置。生产代码和原有测试未修改。新增 25 个公开入口用例：8 通过、17 失败；失败保留为真实红测，没有 skip、降低阈值或修改旧断言。

## 1. 证据与统计

基线 core/src SHA256：`9f2ff06904b16ef3bb4cdaa1912eb3479c7aa38a69ac1de9fabadce50b6523f3`。三个 worktree 从当前未提交实现复制，依赖目录只读复用；主目录源码哈希在审查结束后保持一致。主审查者逐文件确认三个副本的生产源码、原测试、scripts 和 gate 配置都未改变。

| 审查方向 | 新增测试通过 / 失败 | 含原基线的完整用例通过 / 失败 | 报告 |
| --- | --- | --- | --- |
| 能力边界与外部组合 | 2 / 3 | 177 / 3，共 180 | [边界报告](/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/reviews/architecture-boundaries.md) |
| 装配事务与实例控制 | 3 / 7 | 178 / 7，共 185 | [事务报告](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/reviews/architecture-transactions.md) |
| 工作与资源生命周期 | 3 / 7 | 178 / 7，共 185 | [生命周期报告](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/reviews/architecture-lifecycles.md) |

每个副本的原有 175 个用例均通过，不把重复运行合计为新增测试。17 个红测不是 17 个互不重复的 bug；其中包括同一不变量的不同症状、GC 场景，以及不同审查者对同一发现的独立复核。

三个副本的 typecheck、lint、build 通过；test 因上述红测退出 1，没有四门全绿结论。每个 typecheck 包含 18 个编译负例与 23 个文档片段。lint 检查零错误、零警告及 57 个生产源文件；build 构建 55 模块。主审查者再次复跑三个新增测试文件，得到同样的 8 通过、17 失败。

覆盖率分别记录，不求平均，不作为架构验收：

| 副本与统计范围 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| 能力边界，失败运行显式输出覆盖率 | 90.75% | 89.07% | 94.59% | 96.43% |
| 装配事务，失败运行显式输出覆盖率 | 90.89% | 89.17% | 95.04% | 96.43% |
| 生命周期，单独原基线运行 | 90.75% | 89.07% | 94.59% | 96.43% |

生命周期的含红测全量运行没有输出覆盖率；表中最后一行明确是单独基线数字。覆盖率配置没有数值 thresholds。

## 2. 已经成立的架构选择

### 业务契约可以在内核之外组合

两个独立 scope 中分别装配入口服务、guard、chain、恢复插件和记录服务。拒绝请求不写记录，允许请求经顺序恢复后写入各自的记录；关闭第一个实例只释放它的消费方资源，另一个继续服务。嵌套调用的 origin、executor、resourceOwner 和 parentId 与外部组合一致。

这证明核心机制能够承载业务插件组合。记录使用内存状态，恢复使用受控失败后的链重试；没有据此宣称数据库恢复、未知工具副作用处理或检查点重放已经实现。

### 契约身份与受限依赖门面有价值

正常 declared 依赖可以在插件的子 scope 继承；bind 不能采用兄弟插件 Context 来扩大权限。跨 root 的 PluginRef 不被接受，旧服务门面不自动重定向到新代次。root 分别维护实例状态与预算。

### 实际工作与公开结果分离的方向正确

正测验证等待环检测、子任务第一次超时不会被迟到成功覆盖，以及未观察 Continuation 失败升级为受管调用失败。Actual/outcome 分离、固定依赖和资源归属是需要保留的内核不变量。

提示词、skill、压缩、LLM 纠错、权限规则、执行环境、房间协议与事实记录仍应由外部服务和插件定义。core 继续负责通用工作、能力、注册与生命周期，不增加 Agent/run/session/room 的业务判断。

## 3. 阻断企业生产验收的机制缺口

### A01 · P1 · 清理不属于完整的受管工作收敛协议

[close-owner.ts:13](../core/src/scopes/close-owner.ts) 仅在 effects 前 drain，[release-effect.ts:22](../core/src/effects/release-effect.ts) 在 disposer 对外返回后就移除资源与 pins。清理调用 timeout 后 actual 仍运行，宿主已经 closed、activeCalls=1、effects=0。

[红测](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:32) 确认了已知 R02。企业实例关闭、连接租约释放和在线卸载不能建立在此状态上。

机制调整：把清理创建的工作显式连接到清理操作，实际收敛之前保留依赖 pins 与提供者资源。停止准入、请求取消、等待实际工作和释放能力形成统一协议；各关闭入口共同使用，不能在已经释放资源之后只补一个计数检查。

### A02 · P1 · 注册预留、同步提供和发布没有共享唯一事实

[load-plugins.ts:79](../core/src/plugins/load-plugins.ts) 可以覆盖激活期间宿主提供的同 token 实现。root 与子 scope 同时取得不同的活跃代次。

[红测](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:59) 确认已知 R03。串行化 load/unload 没有保护同步 provide 路径。

机制调整：提供项用同一注册表表示预留、暂存、发布和撤销，所有入口共用占用与代次检查。发布前验证自身预留和祖先约束，原子提交可见状态。需要统一的是状态所有权，而非新增一个仅供 load 使用的锁。

### A03 · P1 · 回滚缺少整批停止屏障

[load-plugins.ts:62](../core/src/plugins/load-plugins.ts) 逐个 close 后才轮到前一个 owner，正常等待批次取消的清理被卡住，根进入 degraded，后续装配被拒绝。

[红测](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:84) 确认已知 R04。

机制调整：先同步撤销整个 cohort 的准入并取消，固定回滚期限，然后按依赖图等待和释放。回滚、级联卸载和作用域关闭共用停止阶段与真实收敛机制。

### A04 · P2 · 后台与结构化任务依赖环境 parent 推断

[start-work.ts:27](../core/src/tasks/start-work.ts) 的 owner.activation fallback 使 apply 中 ctx.spawn 的常驻 worker 加入激活自动 join，正常插件无法发布。

[事务红测](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:115)及[生命周期红测](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:57) 独立确认已知 R11。

机制调整：Work 创建意图明确区分 owner 后台、结构化子任务、绑定调用及清理工作；该关系同时决定 parent、资源拥有者、取消、期限和连接等待。常驻队列 worker 必须能够发布后继续运行，并在 owner 关闭时取消和 drain。

### A05 · P2 · 能力失效与引用释放是两套不完整路径

[create-dependency-context.ts:13](../core/src/context/create-dependency-context.ts) 的 bound/cleanup 门面，以及 [wait-task.ts:35](../core/src/tasks/wait-task.ts) 的已结束等待 reaction 仍保持 runtime/view/waiter/signal 强引用。

[三组 GC 红测](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:176) 有成功收集的对照，独立确认已知 R09/R10。只有 done、finished 或拒绝准入不足以释放引用。

机制调整：能力门面与结果订阅使用可撤销引用单元，生命周期结束时明确清空重引用。失效句柄可保留轻量结果和身份，但不能继续保留整个宿主；原生 Promise reaction 也不能间接保存已结束消费方。

### A06 · P2 · 定义预算没有覆盖实际留存

[plan-load.ts:33](../core/src/plugins/plan-load.ts) 只登记 provides，漏掉 manifest 和 optional 引用；[provide-definition.ts:47](../core/src/services/provide-definition.ts) 撤销时又把 token 放入 scope.tombstones 强 Set。

optional 预算及同名身份两组红测分别复核已知 R12。新增[在线变更 GC 红测](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:182) 证明 maxDefinitions=1 下，33 次成功登记/撤销后仍保留 33 个退休 token；没有违反活跃注册数量，却线性积累历史。

机制调整：定义生命周期统一管理名称、身份、有效引用和容量。需要强保留的引用计入预算；撤销标记避免强保留已无外部引用的历史 token，同时继续阻止既有撤销身份回退到祖先。不能把删除活跃 Map 当成定义已回收。

## 4. 本轮新增的其他逻辑问题

### A07 · P2 · 创建子 scope 后失去创建者自身已提供能力

[create-scope.ts:32](../core/src/scopes/create-scope.ts) 复制 plugin/name 与固定依赖，没有委派创建者的 self provider；[resolve-provider.ts:19](../core/src/services/resolve-provider.ts) 直接按插件身份拒绝祖先解析。

[红测](/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts:156)：ctx.use 自身 token 成功，ctx.scope 后 child.use 同一 token 返回 undeclared-dependency。

资源拥有者与能力委派需要分开建模，派生 Context 只能继承被允许的提供者身份。修复不能让带 pluginName 的 Context 任意搜索祖先，也不能通过保存父 ctx 绕过子调用归属。

### A08 · P2 · 等待缺少自身默认期限

[wait-task.ts:33](../core/src/tasks/wait-task.ts) 仅在显式 timeoutMs 时创建 timer。callTimeoutMs=10、目标预算=100 时，root.wait(task) 在 10ms 后仍未返回。

[红测](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:82) 使用正常执行的可控 timer，确认新增问题；它与旧 R06 的迟到 timer 问题是两个触发场景。

等待应有统一记录，固定默认或显式期限，纳入父期限与取消，交付前检查单调时钟，并结束订阅；目标取消仍独立处理。

### A09 · P2 · 关闭回执按全局差值统计，不能描述本次操作

[close-scope.ts:19](../core/src/scopes/close-scope.ts) 读取全宿主 effect 数量，[close-scope.ts:56](../core/src/scopes/close-scope.ts) 结束时相减。子树实际释放 1 个 effect，等待期间 root 合法登记 2 个 effect，成功回执 releasedEffects=-1。

[红测](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:176) 直接确认计数错误，不依赖后代插件是否应列入回执的语义解读。另一个红测确认 stoppedPlugins 只列直属插件，实际停止的后代没有列出。

关闭操作需要保存自己的成员和真实完成记录，回执从这些事实计算。全局 inspect 计数可以诊断总量，不能相减后充当并发操作的释放账本。

## 5. 内部层次与接口合理性

主审查者用 Bun.Transpiler.scan 提取运行时导入，排除测试与 type-only imports；57 个生产源文件存在两个非平凡强连通分量：

1. 10 个文件：chains/dispatch-chain、context/create-dependency-context、context/create-invocation、effects/register-effect、effects/release-effect、guards/dispatch-guard、services/invoke-service、services/use-service、tasks/spawn-task、tasks/start-work。
2. 3 个文件：scopes/close-owner、scopes/close-scope、scopes/stop-owner。

这是依赖事实与修复耦合风险，不是“有环就运行错误”的断言。ARCHITECTURE 声明生命周期层不能反向依赖 context 工厂，当前实现与该方向不符；现有检查仅约束外部依赖，没有验证内部层次。

建议围绕三项深层职责重整实现：

| 职责 | 统一隐藏的复杂性 | 上层依赖方式 |
| --- | --- | --- |
| 受管执行 | 准入、校验、意图、首次结果、实际工作、期限、取消和等待订阅 | service/chain/guard/event/activation/cleanup 使用同一执行机制 |
| 能力与注册 | 定义引用、提供项预留与代次、受限委派、门面撤销 | Context 暴露窄接口，装配通过统一注册事实提交 |
| 生命周期收敛 | 批次/子树停止屏障、工作连接、资源依赖、释放与关闭回执 | 宿主控制入口组合操作，不各自重新实现收敛规则 |

这些是职责边界，不要求再发布三个包或为每次方法调用增加一层插件。公共 Context facade 只组合接口，生命周期不再反向导入包含权限及执行流程的公共工厂；确有反向接入需求时使用内部窄接口在 root 创建处装配。先保证单一状态所有权，再确定文件划分与允许的依赖边，并把该边界加入现有检查。

接口易用性还应明确区分 [Disposer 清理回调](../core/src/contracts/types.ts) 与 [登记返回的释放句柄](../core/src/effects/register-effect.ts)。当前同一签名要求消费方传 CleanupInvocation，但返回句柄会忽略它并由内核生成真正清理上下文。可以让清理 callback 接收 cleanup、主动 release 无需伪造 cleanup 参数；这是接口设计建议，没有把未承诺的零参数调用写成红测。

## 6. 企业应用能力与外部责任

| 企业需求 | core 应提供的基础 | 本轮判断 |
| --- | --- | --- |
| 上下文、提示词、skill、压缩与纠错 | typed service、chain、身份和受管资源 | 纯插件组合方向成立，具体业务协议仍由外部提供 |
| 多 Agent 与房间 | scope、独立实例、受控实例管理服务、后台任务 | 可组合；合法后台发布与派生能力问题需先修复 |
| 权限与 sandbox | guard、受控执行服务、取消与资源归属 | 守住受控入口；同进程插件不是敌意代码沙箱 |
| 记录、投影、检查点与恢复 | 外部记录服务、持久位置、幂等和副作用协议 | 不要求进入 core；本轮未验真实崩溃恢复 |
| 在线安装与卸载 | 提供项预留、依赖代次、批次停止和真实关闭 | 当前红测阻断生产验收 |
| 长期运行 | 真实期限、引用释放、容量与可观察关闭事实 | 当前 GC/预算/回执红测阻断生产验收 |
| 不同应用故障隔离 | 明确的 root 故障域或外部执行隔离 | scope 是可见性和生命周期边界；当前 mutation/degraded 是 root 级共享 |

不能把同一 root 中的 scope 解释成独立 SLA 或强租户安全边界。需要独立故障域的应用应使用独立 root 或外部执行宿主；若需要在一个 root 中分区故障和配额，先明确通用机制与契约再实现，不为 room/tenant 增加业务判断。

## 7. 红测复跑与交付边界

审查 worktree 保留，生产修复阶段可以把这些测试迁入主目录同名 __test__ 路径。当前未把失败测试混入主目录后宣称全绿，也没有归档销毁审查证据。

| 工作区 | 新增测试 |
| --- | --- |
| `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2` | [architecture-boundaries.review.test.ts](/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts) |
| `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2` | [architecture-transactions.review.test.ts](/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts) |
| `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2` | [architecture-lifecycles.review.test.ts](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts)、[隔离 GC 夹具](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.gc-case.ts) |

在各自工作区执行 `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts core/src/context/__test__/<对应文件>.review.test.ts`，应看到上述真实失败。修复前 test 不通过是当前审查结果，不能作为已完成生产实现的验收。

本轮没有压测、真实模型/工具 I/O、数据库事务、进程崩溃恢复、跨进程执行、外部认证或生产租户旅程。建议先完成受管执行、注册事务和引用/关闭机制整改，使这批红测转绿，再开展对应领域插件及真实外部旅程验收。
