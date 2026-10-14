# 内核测试说明

全部内核运行测试、类型正负例、GC 子进程夹具和共享测试辅助函数都位于 core/src/**/__test__/。运行测试只导入公开入口 index.ts；不读取内部注册表，不跨包引用私有测试文件。

## 场景与位置

| 位置 | 主要验证 |
| --- | --- |
| contracts/__test__/definitions.test.ts | 声明垃圾输入、描述快照、保留名称、token 身份和服务签名 |
| contracts/__test__/validator-failures.test.ts | input/output/failure 回调异常、schema 拒绝、事件与 guard 阻断、输出校验截止时间 |
| contracts/__test__/type-fixtures | 正确公开 API 推断、18 个错误接口使用的编译负例 |
| services/__test__/services.test.ts | 固定依赖、可选依赖、祖先解析、遮蔽、失效门面和服务错误 |
| services/__test__/boundaries.test.ts | 提供失败不占名称、代次替换、缓存、配额、嵌套调用身份和非法 Result |
| context/__test__/lifecycle.test.ts | 批次原子发布、依赖图、回滚、激活取消、真实关闭和结构化任务 |
| context/__test__/extensions.test.ts | chain 重试/短路/顺序、guard 明确拒绝、有界通知与监听 FIFO |
| context/__test__/invalid-inputs.test.ts | 非法对象、数组、配置、时间和 signal；访问器不执行；不分配资源 |
| context/__test__/review-regressions.test.ts | 消费方资源先清理、cleanup 嵌套调用、宿主隔离、子作用域权限和等待观察 |
| context/__test__/task-deadline-regressions.test.ts | 真实结算后的失败处理、顺序子任务配额、计时器尚未运行的期限检查 |
| context/__test__/shutdown-boundaries.test.ts | 迟到清理收敛、保存的清理门面、失败监听隔离、Continuation 派生分支、guard 超时 |
| context/__test__/lifecycle-safety.test.ts | 同拥有者清理 pins、卸载重试、依赖快照、自有子作用域级联、全局资源预算、首次超时/取消和迟到资源创建 |
| events/__test__/snapshot-boundaries.test.ts | JSON 字节/深度/节点边界、转义、共享引用、非法原型和不可变快照 |
| effects/__test__/release-references.test.ts | 生命周期结束后的强引用释放与隔离 GC 验证 |

## 断言原则

正常路径检查结果、执行次序与身份。失败路径检查错误码、用户代码是否进入、资源计数是否保持一致；取消与超时同时检查公开结果和未完成工作的真实账本。所有可控 Promise 最终明确结算，关闭后验证相应计时器与资源回零。

竞态使用可推进单调时钟、可控 Promise 与显式微任务刷新，不依赖随意等待真实时间。GC 检查单独运行 Bun 进程，保留公开句柄后检验宿主对象回收，不能用资源计数代替引用释放。

回归用例名称描述错误症状。故障注入验证关键用例确实能发现错误；检查后恢复源码并跑完整验证。覆盖率只帮助定位遗漏，不决定一个行为是否正确。

## 运行

在 packages/v2 目录执行：

```sh
bun run typecheck
bun run lint
bun run build
bun run test
```

typecheck 包含静态正例、逐个编译的负例和文档示例。test 使用 Bun 运行 Vitest 并输出覆盖率。运行结果与适用边界记录在 [验收文档](../../../VERIFICATION.md)。
