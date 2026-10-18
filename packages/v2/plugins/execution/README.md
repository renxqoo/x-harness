# Execution 契约

平台无关的执行服务。宿主安装一个提供者，tools 通过可选依赖使用它；core 不包含命令、文件权限或工具调度概念。

- `prepare({profile,argv,cwd?,env?})` 返回冻结的 ExecutionTarget。包含独立 id、backend、profile、绝对 argv/cwd、完整 env、resources 和 restrictions。`createExecutionTarget` 创建共享身份的目标；结构相同的普通对象不能冒充目标。
- `run({target,signal?,timeoutMs?})` 返回 `{ok:true,value:{exitCode,stdout,stderr}}`，或中性错误 Result。非零退出属于命令结果。提供者必须验证目标归属、检查批准后的变化、约束并发与输出，并在实际进程/输出结束后完成工作。
- `ResourceClaim` 使用 domain、分段 path、exact/subtree 与 read/write。`readResources`、`normalizeResources`、`mergeResources` 共享规范化逻辑；最终最多 128 个，JSON 最多 64 KiB。强声明覆盖弱声明，不以字符串前缀冒充目录边界。

自定义容器、远程执行或其他平台沙箱可以通过普通 `definePlugin({provides:{execution}})` 与 `ctx.service` 实现同一服务；不需要修改 tools、scheduler 或 core。声明的 restrictions 必须反映真实保证，不能在隔离失败时悄悄改为宿主执行。进程内资源锁不能代替远端调度、分布式锁或数据库事务。

公共错误码：invalid-input、backend-unavailable、profile-not-found、target-changed、access-denied、busy、output-limit、cancelled、timeout、execution-failed、closed。服务边界还可能返回 core 生命周期错误。错误不回显命令、环境或系统异常；命令自己的 stdout/stderr 属于其有界输出。
