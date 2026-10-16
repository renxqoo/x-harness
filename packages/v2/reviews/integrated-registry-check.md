# 集成后注册与撤销边界复验

本轮从隔离 worktree 直接导入主工作区公开 `core/src/index.ts`，生产只读。没有把本地共享基线覆盖回主工作区。三个新增用例的实际结果为 2 pass / 1 fail；typecheck、lint 通过（18 个类型负例拒绝、23 个文档片段通过类型检查）。

## P1：手动撤销与同一 tick 的业务调用存在准入窗口

红测位置：`/Users/wrr/.codex/worktrees/core-review-transactions/x-harness/packages/v2/core/src/plugins/__test__/integrated-registry-boundaries.review.test.ts:31`。

主工作区位置（复验时）：

- `/Users/wrr/work/x-harness/packages/v2/core/src/effects/register-effect.ts:25` 同步检查 beforeRelease，但第 29 行调用异步 releaseEffect。
- `/Users/wrr/work/x-harness/packages/v2/core/src/services/provide-definition.ts:48` Provider 的真正撤销发生在该清理回调的后续微任务。
- `/Users/wrr/work/x-harness/packages/v2/core/src/services/provide-definition.ts:67` 在手动撤销许可发出时只检查当时的 owner.activities。

最小反例：提供一个返回 gate Promise 的服务，取得旧门面；同一同步调用栈先调用 off()，紧接着 oldFacade.run()；等待 off 回执并观察账本，再释放 gate。

Expected：off 成功意味着撤销已停止新增业务准入；紧随其后的旧门面调用失败，方法不进入、activeCalls=0。

Actual：off 回执成功，但方法已进入，activeCalls=1；gate 释放后调用还返回成功。测试在断言前主动释放 gate，没有留下挂起工作。

影响：宿主收到成功撤销回执后可能释放适配器、连接池或外部资源，但刚在准入窗口进入的实现继续执行。正确固定代次并不能代替撤销的同步准入屏障。

机制方向：许可检查成功后同步进入 retiring 状态，停止业务入口，保留实现与已有清理依赖直到真实收敛。closing Provider 的 scope slot 必须继续占用，普通 provide 不能只检查 active，否则同步停止业务后会把仍在清理的代次覆盖。新获得的子作用域委派或 cleanup pin 也应按 retiring 状态决定是否可以绑定，既有固定清理依赖仍可调用。

## 已通过的对照

- 插件在 apply 中创建的子作用域固定委派 Provider 代次；卸载创建者后子作用域关闭，定义引用释放，可以再次提供同名不同身份的定义。
- 子作用域消费资源的 cleanup 失败后，Provider pin 仍保留；默认和 cascade unload 均返回 plugin-in-use，外部提供者仍 active，没有把失败资源账本删除成成功。

测试文件仅使用公开 API，没有持久事务、可靠消息或恶意代码沙箱断言。迁入主工作区时应将文件中两条绝对主工作区 index import 改为 `../../index`；所有测试主体与断言保持不变。
