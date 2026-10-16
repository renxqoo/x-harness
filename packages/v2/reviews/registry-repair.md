# 注册事务与定义生命周期

## 当前机制

定义索引保存一份名称与 token 身份关联，并保存使用该定义的引用身份集合。插件 manifest 的 requires、optional、provides 共用这一索引；缺席 optional 仍持有定义引用和容量，但其固定绑定保持缺席。Provider 单独持有定义引用，手动撤销 Provider 不会删除仍由其他 manifest 或委派拥有者引用的定义。最后一个受管引用释放后，名称与容量可以重新使用。

插件规划先验证整个批次的名称、定义身份、容量和依赖图，不登记部分批次。成功规划后，reserveInstall 为整个批次同步取得定义引用与 scope/provider slot，再开始异步 apply。预留 slot 对公开能力解析不可见，但同步 host.provide 必须服从同一占用事实。配置 provider 失败也不能提前让尚在运行的 activation 丢失其预留。

publishInstall 在一个同步步骤中重检作用域状态、Owner 取消、固定依赖可用性、定义预算、预留身份和祖先遮蔽条件，再发布整个批次。显式 shadow 由 Provider.shadow 固定保存，异步激活期间祖先提供项变化不能引入隐式遮蔽。

rollbackInstall 先同步停止整个 cohort，再进入逆序真实收敛与清理。所有 cohort Owner 的 cleanupDeadline 收紧到同一个批次截止时间，取消回调推进时钟也不能重置各 Owner 的完整清理预算。预留释放只针对已停止的所属 Provider，无法收敛的引用和预留继续由账本保留，宿主保持 degraded。

作用域 tombstones 使用 WeakSet，仍能拒绝旧 token 的静默祖先回退，且不让长寿命作用域强持有已撤销定义。Owner 使用不变的 kind 区分 host/plugin；停止状态不能把宿主拥有者误算为安装的插件。

unload 的 releasedEffects 由本次操作所拥有或依赖的实际成功释放 Effect 身份累计生成，不使用根宿主全局总量差。监听随 actual 完成或失败解除；公开 timeout 不提前释放实际清理的统计监听。

load 仅把 undefined scope 视为省略。显式 null、false、0、空字符串以及其他不属于本宿主的身份均返回 invalid-input。

## 独占交付文件

以下文件均位于 `/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2`，可迁入当前分支：

- `core/src/plugins/plan-load.ts`
- `core/src/plugins/load-plugins.ts`
- `core/src/plugins/reserve-install.ts`
- `core/src/plugins/publish-install.ts`
- `core/src/plugins/rollback-install.ts`
- `core/src/plugins/unload-plugin.ts`
- `core/src/services/provide-definition.ts`
- `core/src/services/revoke-provider.ts`
- `core/src/runtime/retain-definitions.ts`
- `core/src/runtime/release-definitions.ts`
- `core/src/plugins/__test__/registry-lifecycle.test.ts`
- `core/src/plugins/__test__/collect-revoked-definitions.gc-case.ts`
- 本文 `reviews/registry-repair.md`

原 architecture-transactions.review.test.ts 的断言保持不变。本 worktree 的共享文件仅用于本地配套验证，不能直接覆盖其他修复。

## 共享接入

Runtime.definitions 为 `Map<string, DefinitionEntry>`；DefinitionEntry 保存 `token: DefinitionRef` 与 `references: Set<object>`。Runtime.reservations 为 `Map<Scope, Map<DefinitionRef, Provider>>`，根初始化为空 Map。Provider 增加 `shadow: boolean`。

Scope.tombstones 改为 `WeakSet<DefinitionRef>`，根与子 scope 初始化为空 WeakSet；关闭末尾不能再调用 Set.clear。Owner 增加稳定 `kind: "host" | "plugin"`；createOwner 默认 host，planLoad 设置 plugin。其他模块的身份分类由主工作区统一接入。

`retainDefinitions(runtime, tokens, reference): Result<void>` 原子校验身份与根容量并持有引用；`releaseDefinitions(runtime, reference): void` 幂等释放引用。closeOwner 仅在真正成功清理时释放 Owner 引用，删除旧按 Provider 列表推断定义存活的逻辑。Provider 引用由 revokeProvider 释放。createScope 在入账前对复制与委派的 bindings.keys 调用 retainDefinitions，以子拥有者为 reference。

loadPlugins 通过 `runtime.createContextView(view)` 装配门面，避免向下模块静态导入 context 工厂。原生 Signal 读取使用共享 `contracts/observe-signal.ts` 的 signalAborted。unloadPlugin 使用生命周期模块的 observeReleases；Runtime.releaseObservers 与 releaseEffect 成功通知由生命周期修复提供。

本地 create-scope/read-limits 来自边界修复，observe-releases 来自生命周期修复。effects/release-effect、close-owner、close-scope、create-context、create-owner、runtime/types 的本地接入只用于验证，不作为本任务独占产物。

## 验证

17 个新增 registry-lifecycle 回归全部通过。GC 用例运行独立 Bun 子进程，父进程施加 1500ms 硬期限；长寿命根和子 scope 交替登记并撤销 32 个不同定义，全部 WeakRef 在任务边界与 GC 后消失。32 个断言对象全部保留检查，没有跳过最后一个 token。创建函数返回前显式让出一个任务边界，避免已经结束的 async 帧暂存最后一个 await 操作影响 GC 判定。

最终本地 typecheck 通过（18 个类型负例拒绝、23 个文档片段通过），lint 通过（0 error / 0 warning，65 个源码边界检查），build 通过（63 个模块）。

本地全测试：15 个文件，14 文件通过、1 文件失败；202 用例，199 pass / 3 fail。剩余三个失败是后台任务 activation parent 与 closeScope 的完整停止回执/并发资源统计，均属于主工作区正在集成的其他修复；本 worktree 没有完整迁入那些生产模块，不将此结果称作全绿。

本地覆盖率（`--coverage --coverage.reportOnFailure`）：语句 90.84%（1379/1518）、分支 89.37%（942/1054）、函数 94.84%（221/233）、行 96.61%（1085/1123）。这是本隔离组合的实测数字，最终集成覆盖率与全绿结论必须由主工作区验证，不降低任何阈值或扩大排除项。

没有操作主工作区、提交、推送、修改旧红测断言或修改门禁配置。
