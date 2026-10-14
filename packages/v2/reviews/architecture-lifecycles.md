# Agent 底座生命周期与有界性对抗审查

审查结论：受管工作账本、显式父调用绑定、资源 owner/executor 分离和实际完成语义的方向成立，但当前实现还不能承诺长运行、高并发 Agent 的真实关闭和有界留存。公开入口复现了关闭后仍有实际工作、合法后台任务阻断发布，以及撤销能力/等待订阅/退休定义持续留存。此结论不要求 core 实现业务重启恢复、可靠消息、沙箱或进程强杀；这些仍由外部插件和执行宿主负责。

审查只在 `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2` 内进行。先独立阅读 API.md、ARCHITECTURE.md、core/README.md 与生命周期源码，再对比已有 `reviews/core-adversarial-2026-10-15.md`。生产代码只读；新增两个测试文件和本报告，没有修复、commit、push 或发布。未读取凭证环境，也未执行旧工程或 e2e main。

## 机制评价与范围

服务、chain 各帧、guard、observer、activation、任务统一进入 `startWork`，拥有真实 `actual` 和首次对外 `outcome`。实际结算前保持计数、取消监听和提供者 activity，是正确基础。父子自动连接、显式 wait 与嵌套调用进入等待图；追加的成功用例验证了子任务等待父任务能返回 wait-cycle，子任务对外超时不会被迟到成功覆盖，未观察的已结束 Continuation 失败能升级为受管 dispatch 失败。

主要架构断层是清理回调与等待不使用完整的工作生命周期；关闭把清理回调返回当成真实清理收敛，等待自行实现期限与订阅。能力撤销只做准入失败，缺少断开强引用的统一协议；定义预算只覆盖活跃注册表，没有覆盖永久退休记录。以下只列五项关键问题。

## L01 · P1 · 清理新增受管调用未完成，关闭已经成功并释放提供者

分类：已有审查 R02 的独立红测复核，当前仍存在。

位置：[close-owner.ts:13](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/scopes/close-owner.ts:13)、[close-owner.ts:15](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/scopes/close-owner.ts:15)、[release-effect.ts:22](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/effects/release-effect.ts:22)、[close-scope.ts:43](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/scopes/close-scope.ts:43)。

最小反例：root 提供等待 deferred 的服务；root.effect 的 disposer 使用 cleanup.context 调用该服务，等待其对外 timeout 后返回成功。callTimeoutMs=10，closeTimeoutMs=100，单调 Scheduler 前进到 10。此时服务实际 Promise 仍未结束。

测试：[architecture-lifecycles.review.test.ts:32](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:32)，用例 `cleanup outward timeout must not publish closed while its actual service still runs`。

预期：关闭继续等待 actual，保留服务与清理资源。实际：`{ state: "closed", activeCalls: 1, effects: 0 }`；预期快照为 `{ state: "closing", activeCalls: 1, effects: 2 }`。测试 finally 打开 deferred，确认该实际调用最终能收敛，不把宿主测试进程留在挂起状态。

影响：在线卸载或关闭期间，资源释放和“已关闭”的保证可以早于真实清理操作。外部连接、订阅或租约可能在 cleanup I/O 继续执行时失效，宿主收到成功回执后仍有活动。这直接破坏企业底座的停止事实。

机制级方向：为每次清理建立有身份的清理工作/子工作连接和固定截止时间；disposer 对外结算不能解除依赖 pins。所有清理产生的实际调用/Continuation 收敛后，才能移除资源并释放提供者。按工作与资源依赖图分阶段关闭，不能仅在 closeOwner 尾部加计数检查；尾部检查时资源已经释放。

## L02 · P2 · 拥有者后台任务被 activation 自动收为结构化子任务

分类：已有审查 R11 的独立红测复核，当前仍存在。

位置：[start-work.ts:27](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/start-work.ts:27)、[start-work.ts:119](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/start-work.ts:119)、[spawn-task.ts:14](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/spawn-task.ts:14)。公开承诺见 [API.md:458](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/API.md:458) 和 [core/README.md:436](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/README.md:436)。

最小反例：插件 apply 用 ctx.spawn 创建等待其 signal abort 的后台 worker，apply 随即返回成功。这个 worker 有明确拥有者、可响应取消，没有创建裸 Promise 逃逸。

测试：[architecture-lifecycles.review.test.ts:57](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:57)，用例 `activation ctx.spawn background work must not block the plugin batch publication`。

预期：批次发布成功，后台任务继续 running，随后随拥有者关闭取消并 drain。实际：load 仍未发布；ctx.spawn 的 parent 通过 `owner.activation` 被推断为 activation。activation 的自动连接等待后台任务，长运行 worker 因而占用激活等待与 mutation 队列，最终会触发激活超时/回滚。

影响：合法的长期维护任务、watcher 或队列 worker 无法在 apply 中启动；长运行应用被迫增加非契约时序绕行，侵蚀统一任务入口。

机制级方向：把任务关系明确编码为拥有者后台或结构化子任务；ctx.spawn 明确没有父 Work，call.spawn 明确继承父 Work。激活中受管服务/绑定调用的 parent 规则可以独立保留，不能通过统一的 `?? owner.activation` 对所有工作隐式注入 parent。测试需要同时验证发布与后台工作的真实停止。

## L03 · P2 · root.wait 没有默认等待期限，期限路径没有统一

分类：新增问题；与已有 R06“显式 wait 的 timer 延迟能交付超期成功”不同。本次反例在合法 timer 正常执行时也成立。

位置：[wait-task.ts:33](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/wait-task.ts:33)、[create-context.ts:76](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/create-context.ts:76)。公开契约 [API.md:509](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/API.md:509) 明确 callTimeoutMs 是默认服务、chain、guard、任务与等待期限。

最小反例：callTimeoutMs=10；创建 timeoutMs=100 且等待 deferred 的目标任务；root.wait(task) 不显式传 timeoutMs；单调 Scheduler 前进到 10 并执行到期 timer。

测试：[architecture-lifecycles.review.test.ts:82](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:82)，用例 `root wait must use the default call budget even when its target has a longer deadline`。

预期：wait 在 10 返回 timeout，目标仍 running；超时等待不取消目标。实际：等待结果仍 undefined，直到目标本身的 deadline/outcome。waitTask 仅在传入显式 timeoutMs 时建立 timer；root.wait 没有父 waiter signal，也没有传入默认预算。

影响：宿主只改变目标预算便能意外延长默认等待；在线控制面和结果查询的等待时间失去独立上界。显式 wait 期限、父期限和默认期限在不同路径实现，容易继续漂移。

机制级方向：建立统一 WaitRecord，准入时固定 `min(now + configured/default timeout, parent deadline)`，交付结果时检查单调时间，并解除订阅/等待图/timer；目标取消仍由 task.cancel 单独控制。不要以等待目标 outcome 的期限代替等待自身期限。

## L04 · P2 · 能力与等待订阅撤销没有释放强引用协议

分类：已有 R09、R10 的独立 GC 复核，按同一撤销生命周期缺口合并为一项，不宣称是新增问题。

位置：[create-dependency-context.ts:9](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/create-dependency-context.ts:9)、[create-dependency-context.ts:13](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/create-dependency-context.ts:13)、[release-effect.ts:35](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/effects/release-effect.ts:35)、[wait-task.ts:21](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/wait-task.ts:21)、[wait-task.ts:35](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/tasks/wait-task.ts:35)。

最小反例与测试：[architecture-lifecycles.review.test.ts:176](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:176) 的三组 `revoked bound/cleanup/wait capability must release consumer references with a successful GC control`，夹具 [architecture-lifecycles.review.gc-case.ts:9](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.gc-case.ts:9)。

bound/cleanup：诊断 sink 闭包捕获 marker；服务调用保存 call.bind(root) 的返回门面，或 effect 保存 cleanup.context；成功 dispose 后丢弃 root，仅保留已经失效的门面。wait：保持目标实际任务运行，短 wait 的 signal 有普通 abort listener 捕获 marker；wait 已 timeout 后丢弃 signal。三组都执行 15 轮跨异步任务 Bun.gc。

预期：能力失效、等待结束后收集 marker。实际：三组 subjectCollected 均 false；对应不保留门面/不建立 wait 的对照 controlCollected 均 true。GC 夹具隔离在 Bun 子进程，父测试 3 秒后可以 kill；测试没有挂住宿主。

影响：保存失效的绑定/清理门面会保留整个 runtime；同一长期任务上的多次短等待会保留已结束的消费方 signal/options/waiter 与 runtime 引用。activeTasks、activeCalls 和 serviceLeases 的上限不能约束这些留存。

机制级方向：统一采用可撤销 capability cell；绑定工作与实际清理完成时清空 runtime/view/work 重引用，失效入口通过独立轻量路径返回失败。任务 outcome 需要可解除的订阅，或让原生 Promise reaction 仅捕获可清空 cell；wait 结束时清空所有消费方引用。不要把 listener.remove 和 done=true 当作引用释放。

## L05 · P2 · 在线撤销 tombstone 永久留存退休定义，绕过定义预算

分类：新增问题；与已有 R12“optional 缺席定义未登记预算”不同。这次注册、撤销均成功，活跃定义数始终不超过 1，退休引用却线性累积。

位置：[provide-definition.ts:33](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/services/provide-definition.ts:33)、[provide-definition.ts:47](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/services/provide-definition.ts:47)、[provide-definition.ts:51](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/services/provide-definition.ts:51)、[close-owner.ts:21](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/scopes/close-owner.ts:21)、[runtime/types.ts:21](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/runtime/types.ts:21)。公开预算见 [API.md:497](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/API.md:497)。

最小反例：保持 root 长期 open，maxDefinitions=1；按顺序定义不同名称的 token、provide、成功调用登记 disposer，然后丢弃 token 与 disposer。所有登记和撤销都成功。

测试：[architecture-lifecycles.review.test.ts:182](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts:182)，用例 `online provider churn must not retain every retired definition beyond maxDefinitions`；夹具 [architecture-lifecycles.review.gc-case.ts:34](/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.gc-case.ts:34)。

预期：root 不强引用所有已经撤销且外部已丢弃的定义，或预算明确拒绝无法回收的增长。实际：一个独立 subject 和随后 32 个 token 均被保留；子进程输出 `{"controlCollected":true,"subjectCollected":false,"retainedDefinitions":32}`。control 是未登记的 token，成功收集。33 次在线登记/撤销从未撞上 maxDefinitions=1。

根因：撤销从 runtime.definitions 删除 token，却把 token 加入 scope.tombstones 的强 Set；只有重新提供同一 token 或关闭整个 scope 才清除。不同 token 的退休历史可以无界增长。Set 中 token 的 definitionData 还能保留 validators 等闭包及其业务数据。

影响：长期宿主在线安装/卸载动态插件和契约时，内存随历史而非活跃容量增长；根 scope 不关闭就不能回收。此反例直接否定当前定义预算是长运行内存上界的说法。

机制级方向：撤销事实按 token 身份保留，应使用弱身份记录或可释放的代次记录，避免为已无外部引用的 token 保持强引用；仍由外部持有的撤销 token 必须继续阻止祖先回退。统一定义引用账本与预算，把所有必须强保留的引用纳入计数，不能通过删除活跃注册表就声称容量已释放。

## 验证结果

本 worktree cwd 为 `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2`。

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过；18 个类型负例拒绝预期错误，23 个文档示例通过公开 API 类型检查 |
| `bun run lint` | 通过；0 error、0 warning，57 个内核源码文件通过边界检查 |
| `bun run build` | 通过；55 模块，产物 76.11 KB |
| `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts core/src/context/__test__/architecture-lifecycles.review.test.ts` | 10 用例：3 通过、7 失败，退出码 1；失败均为上述明确预期/实际偏差 |
| `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --exclude '**/*.review.test.ts'` | 仅用于单独统计原有基线：13 文件、175 用例全部通过 |
| `bun run test` | 包含新红测：14 文件，185 用例，178 通过、7 失败，退出码 1；本次全量失败运行没有输出覆盖率报告 |

原有基线覆盖率为语句 90.75%（1276/1406）、分支 89.07%（864/970）、函数 94.59%（210/222）、行 96.43%（1000/1037）。这是明确排除本轮审查探针后的基线数字，不是含红测的“门禁全绿”，也不等于覆盖率达标结论。未修改覆盖率阈值、vitest 配置、生产代码或现有断言，没有 skip。

新增文件：

- `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.test.ts`
- `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/core/src/context/__test__/architecture-lifecycles.review.gc-case.ts`
- `/Users/wrr/.codex/worktrees/core-review-lifecycles/x-harness/packages/v2/reviews/architecture-lifecycles.md`

本轮没有进行吞吐量/延迟压测，也没有证明任意规模等待图的算法复杂度或完整无死锁。GC 证据限定在本机 Bun 的 WeakRef/强引用路径，不能当作任意 JS 引擎的即时收集承诺。当前反例已经在无需恶意裸 I/O、无需无限同步循环、无需业务持久恢复的公开 core 操作中打破关闭事实与长期容量约束；因此修复这些机制并再次对抗验证前，不宜把当前内核认定为已达到企业 Agent 底座生产验收。
