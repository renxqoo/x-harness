# 装配事务、注册表和实例生命周期架构审查

结论：纯插件方向适合企业 Agent 的进程内组合内核，但当前实现不能作为已验收的企业生产底座。业务协议不需要进入 core；装配预留、批次取消、任务父关系和定义引用必须成为统一且可验证的内核机制。以下五项结论全部来自公开 index.ts 复现，其中四项是对既有 review 的独立复核，一项为新增发现。问题不是要求 core 变成持久事务、可靠消息或恶意代码沙箱。

本审查的全部读取、写入与验证均在隔离 worktree 的 packages/v2 中执行。生产代码只读，仅增加一个审查测试文件及本报告。没有 commit、push、修改配置、改生产断言、skip、代码注释或读取凭证环境。

## 1. P1：装配预留与同步 provide 不共用注册表，发布可产生两代活跃实现

状态：独立复核已有 R03。

位置：

- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/plan-load.ts:34` 只检查已发布 provider 和本事务私有 provider。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/services/provide-definition.ts:23` 只检查当前 owner 与 scope 的活跃 provider。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/load-plugins.ts:79` commit 直接覆盖 scope.providers。

最小反例：load 一个提供 token 的插件；apply 在 provide 后等待 gate。等待期间 host.provide 相同 token；释放 gate，load 成功。没有并行插件装配，也没有绕过公开 API。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:59`。

Expected：第二次 provide 返回 duplicate-provider；root 和普通子作用域均只能调用同一已提交的插件代次。

Actual：第二次 provide 成功；root 调用得到 `host`，普通子作用域调用得到 `plugin`。根拥有者自有 provider 与 scope 已发布 provider 分叉，两个实现都活跃。

影响：企业应用常在启动与在线装配期间登记宿主适配器。一次成功的 load 无法证明只有一个能力实例，消费者、清理 pin 和卸载对不同代次形成不一致事实。仅串行 load/unload 不足以保护其他登记入口。

机制调整：提供项身份由统一注册表管理，显式表示 reserved/staged/published/revoked；plan、同步 provide、publish 与 release 都通过同一占用事实。预留要占容量但不提供外部可见能力；发布核对 reservation owner、祖先遮蔽条件和固定依赖代次后一次提交。不能靠文档要求宿主不在 apply 期间 provide。

## 2. P1：回滚逐个停止，批次取消屏障缺失，正常协作清理会变成全根故障

状态：独立复核已有 R04。

位置：

- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/load-plugins.ts:62` 逐个 await closeOwner 后才轮到前一个 owner。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/load-plugins.ts:68` 在回滚期间设置根级 degraded。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/load-plugins.ts:22` degraded 拒绝整个根宿主的后续装配。

最小反例：first 激活成功；second 登记一个等待 first.signal abort 的 disposer，然后返回失败。这个 disposer 会在批次统一停止时立即结束，既没有永久不响应取消，也没有外部事务。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:84`。

Expected：先取消全部 owner，再逆序 drain/清理；load 返回 activation-failed，first 已 abort，degraded=false，plugins/effects 为空。

Actual：关闭预算达到时返回 activation-unsettled；first.signal.aborted=false、first 仍 staging、second stopping、effects=1、degraded=true。测试最终调用全根 dispose 才解除阻塞，未留下挂起进程。

影响：普通初始化失败可以冻结所有应用实例的在线装配。事务状态虽改为 rollback，尚未轮到的 owner 仍满足 staging 准入，停止协议缺少全批次一致的前置动作。

机制调整：事务统一持有 cohort、取消屏障、固定回滚期限和真实工作账本；进入 rollback 同步撤销全部 owner 准入并取消工作，然后才按依赖顺序等待与清理。停止/等待/释放需要分成明确阶段，rollback、cascade unload、closeScope 共用这一协议，防止同类次序缺口分别出现。

## 3. P2：任务父关系由 activation 环境推断，拥有者后台工作被误纳入提交屏障

状态：独立复核已有 R11。

位置：

- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/tasks/spawn-task.ts:14` ctx.spawn 的显式 parent 为 undefined。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/tasks/start-work.ts:27` undefined 随后回退到 owner.activation。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/tasks/start-work.ts:119` activation 自动等待被错误归为结构化子任务的背景 worker。

最小反例：apply 使用 ctx.spawn 启动等待自身 signal 的后台 worker，随即返回成功。activationTimeoutMs=10，后台 callTimeoutMs=1000。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:115`。

Expected：load 成功，插件 active、后台 activeTasks=1、任务 parentId 缺席；dispose 取消并 drain worker。

Actual：任务 parentId=`work-2` 指向 activation；10ms 后 load 失败并回滚，plugins 为空、activeTasks=0。worker 收到取消并结束，说明并非不合作插件造成失败。

影响：订阅、轮询、维护缓存等常见常驻插件不能遵守公开后台任务契约正常启动；为了绕开该结果而把任务移出 core，反而破坏企业资源归属。

机制调整：Work 创建应显式选择结构化父调用或拥有者级工作，不用 nullish fallback 推断。后台 worker 的寿命属于 Owner；Invocation.spawn 的寿命属于 Work；activation 只连接真实初始化子任务。这一类型与数据模型区分应同时决定 parentId、resourceOwner、取消、deadline 和自动 join，而不是只改一个字段。

## 4. P2：定义账本只按 provider 维护，有引用的缺席定义不受名称及容量约束

状态：独立复核已有 R12。

位置：

- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/plan-load.ts:23` requires/optional/provides 仅共同验证对象身份。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/plan-load.ts:33` 只有 provides 进入定义索引。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/plan-load.ts:45` 容量检查遗漏 optional 引用。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/services/provide-definition.ts:51` 释放也仅从剩余 provider 推断定义存活。

最小反例一：maxDefinitions=1 的根宿主加载 optional 引用两个定义、没有 provides 的插件。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:145`。Expected resource-limit；Actual load 成功。

最小反例二：插件固定 optional 引用 token A；再 define 同名不同身份 token B 并 host.provide。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:154`。Expected definition-conflict；Actual provide 成功。

影响：模块化系统经常有条件功能与暂缺的 optional 适配器；这类有效插件可突破 maxDefinitions，并在同一根宿主留下同名异身份的契约。原消费者仍固定缺席，而新 provider 看似占用同名能力，名称诊断和实际关联脱离。

机制调整：DefinitionRecord 保存 identity/name/kind 和明确引用计数，manifest、依赖绑定、provider、transaction reservation 以及必要撤销记录都通过同一账本取得/释放引用。optional 缺席的固定绑定语义仍应保持；定义引用登记不意味着动态补依赖。预算由账本真实占用决定，不从当前提供者列表反推。

## 5. P2：关闭回执使用全局计数差，子树外并发登记可产生负数；同时漏报后代插件

状态：本轮新增，现有 review 未记录。releasedEffects 的负数反例直接违反本次关闭释放资源的计数语义，不依赖 stoppedPlugins 应否列全后代的解释。

位置：

- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/scopes/close-scope.ts:19` 记录的是 runtime.effects 全局总量。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/scopes/close-scope.ts:56` 以两次全局总量之差生成 releasedEffects。
- `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/scopes/close-scope.ts:21` stoppedPlugins 只收集直属 scope.owners，实际第 38 行会关闭子树。

最小并发反例：child 登记一个等待 gate 的 effect；host.closeScope(child) 进入清理等待。此时根作用域仍 open，host.effect 合法登记两个子树外资源。释放 child gate，子树成功关闭，根作用域保留两个资源。

红测：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:176`。

Expected：成功回执 releasedEffects=1，inspect.effects=2、scopes=1。

Actual：成功回执 releasedEffects=-1，inspect.effects=2、scopes=1。子树的一个 effect 确实已释放；外部新增的两个 effect 把回执计数从 1 减成了 -1。

后代插件对照：application 作用域装一个插件，其下 agent 作用域再装一个插件，成功 closeScope(application)。红测 `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts:165` 预期 stoppedPlugins 包含 application 和 agent，实际仅含 application，尽管 inspect.plugins 已为空。此项按 CloseReport.stoppedPlugins 表示本次操作停止集合解读；若产品有意只列直属插件，需要明确收窄契约，并另提供完整受影响集合。

影响：企业实例管理、资源配额核销、监控与调度插件无法信赖一次成功关闭回执；合法的无关应用资源登记会污染当前关闭统计，甚至形成不可能的负数。真实资源关闭正确并不能补偿错误的控制结果。

机制调整：关闭先固定受影响的 scope/owner/plugin 身份，按本次操作实际释放成功的 Effect 身份累计计数，而不是比较全根可变总量。处理在途创建的迟到资源时，将实际归入本次 drain/cleanup 的资源计入操作账本。scope close 与 cascade unload 共用这一集合和统计协议，回执从操作账本生成；不能简单 Math.max(0, difference) 掩盖跨实例污染。

## 架构适用范围与必要调整

当前边界把服务、扩展点、拥有者、作用域和持久业务协议分开，是合理方向。三个公开对照通过：普通 staging 服务在根外不可见、失败回滚清空登记；旧门面卸载后不会重定向到新 provider；两个独立根宿主可以使用相同定义和插件而隔离状态、容量、PluginRef。业务持久化、恢复、授权执行入口和进程隔离可以由外部插件实现，不需要内核预设 Agent 角色、消息、checkpoint 或数据库。

不过“子作用域隔离”目前只给能力可见性和生命周期树，不给独立装配故障域。`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/queue-mutation.ts:9` 是全根串行队列；degraded、定义索引、activeCalls/activeTasks 和总容量也属于根。一个 scope 的激活或清理阻塞会延迟其他 scope 的管理操作；无法回滚会拒绝全根的新装配。这是当前有意的根级一致性机制，不另计为违约 bug。

企业应用必须在实现上明确选择故障域：需要独立可用性的租户/应用使用独立根宿主，跨根协作走受限外部协议；只有共享命运的实例放同一根下。若产品要求同根多应用仍独立管理，则需要按作用域/依赖连通分量组织冲突锁、预算账本和失效传播，保留祖先依赖的同步约束，不能简单去掉串行队列或 degraded 保护。

动态实例管理服务不能仅写“apply/cleanup 不要等待 load/unload”的文档。受限管理端口必须在实现中检查调用阶段、受影响拥有关系，采用受理身份与后续结果协议，阻止生命周期阶段的自等待，并有对应夹具。core 的公开控制口与业务调用账本之间尚无自动可观测的控制等待边；当前架构把这一验证责任放在外部管理服务，企业集成验收需证明该服务确实执行约束。

在线 load/unload 的合理语义是显式重新装配与固定代次：当前没有服务透明热替换承诺，本报告未据此制造失败。先把预留、发布、回滚、级联、作用域关闭变成统一生命周期操作，再添加需要的受影响集合/预览能力；用可执行不变量维护企业可靠性，比在各入口补一次 Map 检查或再写文档更可持续。

## 验证

新增审查文件：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/context/__test__/architecture-transactions.review.test.ts`。所有被测 core 能力仅从公开 index.ts 导入；没有跨模块私有测试 helper 引用。

- 审查用例：10 个，3 pass / 7 fail；7 个失败对应上述五组机制结论。
- 全工作区测试（最终使用下述覆盖率报告命令）：14 文件，13 文件通过 / 1 文件失败；185 用例，178 pass / 7 fail。原有 175 用例全部通过，新增的 3 个正常对照通过。
- `bun run typecheck`：通过；18 个类型负例按预期拒绝，23 个文档片段通过类型检查。
- `bun run lint`：通过，0 error / 0 warning；57 个内核源码文件通过依赖和代码风格检查。
- 默认 Vitest 在测试失败时不生成覆盖率；为如实取得数字，单次重复运行 `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.reportOnFailure`，结果同为 178 pass / 7 fail。
- 覆盖率：语句 90.89%（1278/1406），分支 89.17%（865/970），函数 95.04%（211/222），行 96.43%（1000/1037）。配置没有 coverage thresholds，这些数字是覆盖率报告，不宣称“覆盖率门禁达标”。
- 本轮未改生产代码，也未重复 build；未执行旧工程、e2e main 或发布。

红测如实保留。测试失败没有被跳过、改期望、改配置或包装为成功；本轮目的为审查验证，不提供生产修复。
