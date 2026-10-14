# 内核对抗审查记录

审查范围：packages/v2/core 的当前完整生产代码、公开契约及相关测试。三个独立子 agent 分别检查契约和权限、并发与生命周期、插件装配和扩展点；主审查者检查测试装置，并独立复核关键复现。

本轮确认 13 组问题：4 项 P1、8 项 P2、1 项 P3。以下问题尚未修复；本轮没有修改生产代码、测试、接口或配置，仅记录审查结果。复现通过公开 index.ts 入口执行，子 agent 的临时脚本已清理。

## 结果索引

| 编号 | 优先级 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| R01 | P1 | Signal 初始化异常遗留工作，关闭可陷入微任务死循环 | [start-work](../core/src/tasks/start-work.ts) |
| R02 | P1 | 清理新增调用未实际结束，关闭已成功且释放提供者 | [close-owner](../core/src/scopes/close-owner.ts) |
| R03 | P1 | 激活和普通 provide 竞争造成两个活跃实现 | [load-plugins](../core/src/plugins/load-plugins.ts) |
| R04 | P1 | 回滚未先取消全批次，导致可响应取消的清理挂起 | [load-plugins](../core/src/plugins/load-plugins.ts) |
| R05 | P2 | 输入校验在工作账本外执行，未计入超时预算 | [invoke-service](../core/src/services/invoke-service.ts)、[dispatch-chain](../core/src/chains/dispatch-chain.ts) |
| R06 | P2 | 等待期限仅依赖 timer，超期目标仍能交付成功 | [wait-task](../core/src/tasks/wait-task.ts) |
| R07 | P2 | 显式非法 scope 被当作缺席，扩大为根作用域安装 | [load-plugins](../core/src/plugins/load-plugins.ts) |
| R08 | P2 | CoreFault 可选身份及 details 未校验 | [normalize-result](../core/src/contracts/normalize-result.ts) |
| R09 | P2 | 已失效的依赖门面仍保留整个 runtime | [create-dependency-context](../core/src/context/create-dependency-context.ts) |
| R10 | P2 | 已结束等待的 Promise reaction 仍保留消费方引用 | [wait-task](../core/src/tasks/wait-task.ts) |
| R11 | P2 | apply 中 ctx.spawn 后台任务被误认为 activation 子任务 | [start-work](../core/src/tasks/start-work.ts) |
| R12 | P2 | 缺席 optional 定义绕过预算和名称唯一性 | [plan-load](../core/src/plugins/plan-load.ts) |
| R13 | P3 | 缺席 chain 的错误码与公开契约不符 | [resolve-provider](../core/src/services/resolve-provider.ts) |

## R01：Signal 初始化必须原子完成

位置：start-work.ts 第 69–73 行；read-call-options.ts 第 14 行；close-scope.ts 第 31 行。

真实 AbortSignal 可以具有覆盖原生 aborted 的自身 getter。品牌验证使用原生 getter，验证通过，随后 startWork 直接读取 signal.aborted，此时工作、计数和等待边已经登记，实际执行与释放链尚未建立。

最小触发是在真实 signal 上定义会抛错的 aborted getter，再向 dispatch 传入该 signal。实际异常逃出 Result 边界，activeCalls 留下 1；随后 dispose 不断等待初始已结算 actual，却没有出账逻辑，产生无限微任务循环，关闭 timer 无法执行。子 agent 中断了挂起复现；主审查者独立确认了异常和残留账本。

应通过固定原生方法或安全包装操作外部 Signal/EventTarget，统一处理异常；初始化必须有原子提交或完整撤销路径，不能存在已入账却没有实际执行与释放链的 Work。

## R02：清理回调结算不等于清理调用实际收敛

位置：close-owner.ts 第 13、15、37–39 行。

配置 callTimeoutMs=10、closeTimeoutMs=100，根宿主提供一个等待 deferred 的自身服务。effect 的 disposer 从 cleanup.context 调用该服务，拿到 timeout 后返回成功。

实际 dispose 返回成功，inspect 同时显示 state=closed、activeCalls=1、effects=0，提供者已经释放。deferred 随后结算，activeCalls 才降为 0。主审查者独立复现了此结果。

closeOwner 只在运行 effects 前 drain activities，遗漏清理过程中创建的真实工作。必须把清理工作的实际结束纳入关闭依赖，在释放被调用的提供者及其长期资源之前收敛；不能仅在函数尾加状态检查，因为那时资源已经提前释放。

## R03：staging 提供项没有参与普通登记冲突检查

位置：load-plugins.ts 第 55–58、77–79 行；provide-definition.ts 第 23–24 行。

插件在 apply 中提供 token 后等待 gate。等待期间，宿主在同一 scope 对同 token provide 另一实现。打开 gate 后，两项操作均成功。

实际 root.use 调到宿主实现，普通子作用域 use 调到插件实现。卸载插件后，子作用域返回 service-unavailable，宿主实现仍然活跃。主审查者独立复现了完整流程。

应统一作用域提供项的预留、登记和发布冲突检查；staging 虽不对外可用，也必须占用提供项。发布前重新核对注册表与祖先约束，不能直接 Map.set 覆盖竞争期间的登记。

## R04：回滚停止全批次应先于逐拥有者清理

位置：load-plugins.ts 第 59–69 行，尤其第 62 行；对应 IMPLEMENTATION.md 的装配步骤 9。

批次 first 激活成功；second 登记一个等待 first.signal abort 的 disposer，然后激活失败。正常处理批次取消时，该清理可以立即收敛。

实际回滚先进入 second 的 closeOwner，first 尚未停止，signal 没有 abort。关闭预算到达后 load 返回 activation-unsettled，first 保持 staging，宿主 degraded，后续 load 继续拒绝。全局 dispose 才解除阻塞。主审查者独立复现了状态和后续装配失败。

进入 rollback 时先统一撤销全批次准入并取消工作，固定回滚截止时间，然后按逆依赖顺序等待实际工作和资源清理。

## R05：输入校验需要在受管调用内执行

位置：invoke-service.ts 第 17 行；dispatch-chain.ts 第 16 行。

使用合法单调 Scheduler，input validator 把 now 从 0 推进到 11ms，再成功返回；调用预算为 10ms。

实际服务和 chain 都进入实现并成功返回，因为 startWork 在校验之后才建立 deadline。主审查者分别复现了两条路径。输入 validator 也先于调用配额和外部取消检查执行。

应先确定原始调用期限、准入和工作身份，再运行校验，校验后重新检查取消和截止时间，才进入业务实现。回归应同时覆盖预算耗尽、已取消请求和资源上限拒绝时 validator 是否进入。

## R06：wait 结果交付必须检查固定截止时间

位置：wait-task.ts 第 21–28、33–41 行。

在 now=0 时等待目标，timeoutMs=10；timer 尚未调度，now 跳到 11，目标在自己的期限内成功结算。

实际 wait 返回 success，虽然等待期限已经到达。主审查者使用可控 Scheduler 复现，结束后 timers=0，排除了残余计时器导致的观察混淆。

wait 应保存固定 deadline，在目标结果交付和取消等结算路径检查单调时钟，不能只依赖 timer。等待超时仍只结束等待，不取消目标，不将目标失败错误地标为已观察。

## R07：显式非法选项不能走缺省分支

位置：load-plugins.ts 第 13 行。

传入 scope=false、null、0 或空字符串，load 成功把插件安装到 root，违反显式 scope 必须属于本宿主且 open 的要求。错误隔离上下文因此扩大到根作用域。

仅 undefined 应表示省略。其他值必须进行身份验证并返回 invalid-input。

同类较轻缺陷位于 create-context.ts 第 22 行及 create-scope.ts 第 16 行：limits=null/false/0/空字符串被静默当作缺席，返回成功并使用继承或默认预算。主审查者已复现；修复选项读取时一并覆盖，不另计问题组。

## R08：CoreFault 必须满足完整公开形状

位置：normalize-result.ts 第 17–21 行。

回调返回 source=core、合法 code/message，但 scopeId=123、details 为函数。实际结果完整透传，并因 source=core 跳过业务 failure validator。

scopeId、pluginName、callId、diagnosticId 应符合声明的字符串类型，details 应符合 JSON 契约。应使用统一 CoreFault 校验处理所有公开字段；只有验证通过的内核错误才走内核错误分支。

这不是要求业务 reason 统一 JSON 化。业务失败仍保持其自己的进程内契约，内核保留来源的错误必须满足内核契约。

## R09：能力失效必须释放闭包引用

位置：create-dependency-context.ts 第 9、13–16 行；release-effect.ts 第 35 行。

effect 保存 cleanup.context，宿主成功关闭后丢弃 root，仅保留该已失效门面。子 agent 用诊断 sink 捕获的 marker 和 WeakRef 检查，10 轮跨异步任务的 Bun.gc 后 marker 仍存活；不保留门面的对照中被收集。保存 call.bind(ctx) 返回的 DependencyContext 也复现。

finished/settled 只限制准入，没有断开 use/dispatch 闭包中的 runtime/view/work 引用。应统一使用可撤销的 capability cell，在绑定工作或清理实际结束时清空重引用；失效入口通过不捕获宿主的路径返回失败。

GC 回归必须扩展到 DependencyContext 和 CleanupContext，不能只保留 service facade、disposer、TaskHandle 和 Invocation。

## R10：等待结束必须清空目标订阅的消费方引用

位置：wait-task.ts 第 35–42 行。

目标任务等待 deferred，预算 1000ms；短 wait 配置 timeoutMs=1 和一个 signal，该 signal 的普通 abort listener 捕获 marker。等待超时后丢弃 signal，10 轮 GC 后 marker 仍在；不执行 wait 的对照中被收集。

task.outcome.then 的 reaction 无法被 finish 移除，仍引用 finish、options.signal、waiter 和 runtime。重复等待同一个未结束目标可以累积已经结束的等待者，不受 activeTasks 数量限制。

应采用可解绑 outcome 订阅，或让 Promise reaction 仅持有可清空 cell；等待结束时解除边、timer、listener，并清空所有消费方重引用。

## R11：后台任务和结构化任务需要显式区分 parent

位置：start-work.ts 第 27 行。

apply 调用 ctx.spawn 创建等待自身 signal 的后台任务，随即返回成功。配置 activationTimeoutMs=10、callTimeoutMs=1000。

实际 ctx.spawn 的 parentId 为 activation Work，load 连接等待该后台任务，10ms 后 activation-failed 并回滚。与 ctx.spawn 归拥有者后台、call.spawn 才是结构化子任务的公开语义不符。

parent 来源需要区分业务嵌套调用、结构化任务和拥有者级后台任务；不能把 owner.activation 当作对所有工作都适用的环境 parent。回归应证明后台工作不阻断发布，同时在拥有者关闭时仍被取消和实际 drain。

## R12：定义存活不能只由提供者推断

位置：plan-load.ts 第 33–45、47–54 行。

maxDefinitions=1 时加载 optional 引用两个不同 token、但没有 provides 的插件，load 成功；随后创建与其中一个 token 同名但身份不同的 token，宿主 provide 也成功。

manifest 与固定 optional 绑定仍持有定义引用，但当前 definitions 只收录提供项。预算和根宿主的名称唯一性均遗漏了这类定义。

应统一维护定义身份、名称和引用计数，把 requires/optional/provides 纳入规划、预留及释放。optional 缺席继续保持固定缺席，不因登记引用而自动重绑。

## R13：扩展缺席故障码需与契约一致

位置：resolve-provider.ts 第 25 行；API.md 第 2 节。

对合法、尚未提供的 chain token dispatch，预期 extension-unavailable，实际 service-unavailable。当前生产路径没有使用 extension-unavailable。

应在扩展调用边界或解析器按 token kind 分类缺席故障，覆盖初次缺席、optional 缺席和撤销后的行为；文档和运行结果使用同一错误语义。

## 验证与限制

主审查者本轮执行 typecheck、lint 和 test：全部通过。18 个类型负例拒绝预期错误，23 个文档片段通过类型检查，13 个测试文件的 175 个运行用例通过。覆盖率：语句 90.75%、分支 89.07%、函数 94.59%、行 96.43%。本轮 build 未重复执行，也未执行旧工程门禁、外部应用旅程或 npm 发布。

基线通过不能否定以上公开入口复现。复现进程及 GC 对照属于独立审查证据，未混入 175 个正式运行用例的统计。对照 GC 确认具体强引用路径，并不构成任意运行环境的内存上界证明。

优先处理 R01–R04，再处理调用期限、能力/等待订阅撤销、后台任务 parent 及定义引用机制。修复阶段需先补症状回归并同步契约，完整运行本工作区四门；涉及所有权、准入和状态机的修复再次独立对抗复验。当前结果不应作为内核已通过生产验收的结论。
