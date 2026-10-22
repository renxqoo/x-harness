# 插件作者与替换对照

在 packages/v2 执行 `bun scripts/compare-journeys.ts /absolute/path/to/cordis > comparison.json`。Cordis 路径必须是包含依赖的本地源码目录，运行不会修改它。普通测试只运行本系统的作者示例，不依赖外部 Cordis 目录。

两组示例分别调用真实公开 API，没有共享框架适配层。`harness/` 是可直接阅读和运行的 TypeScript；`cordis/` 的 `.case` 只替换导入路径，生成用于执行和类型检查的 TypeScript。共同的 Endpoint 是一个业务协议；它的 Result 形式是本系统要求，Cordis 作者可以自由选择其他返回形式。

| 场景       | 本系统                                  | Cordis                                              |
| ---------- | --------------------------------------- | --------------------------------------------------- |
| 服务       | token、声明、ctx.service、call.deps     | Context 扩充、provide、inject、Context 属性         |
| 异步资源   | ctx.resource 的 open/close              | async apply 返回 async disposer                     |
| 后台任务   | ctx.startTask 绑定取消及实际结束        | 作者显式 AbortController，disposer 等待实际 Promise |
| 事件       | 声明 payload，发送准入后显式等待到达    | Events 扩充，parallel 等待监听者结束                |
| 提供者替换 | application.setPlugins 重装受影响消费者 | dispose/install，等待依赖 Fiber 就绪                |
| 在途调用   | 受管调用实际结束后清理资源              | 示例中普通 Promise 没有额外逐调用登记               |

双方服务、资源、任务、事件及消费者重启得到相同业务结果。保存的本系统入口在替换后拒绝调用；Cordis 示例中保存的消费入口通过 Context 解析新提供者。直接保存的 Cordis 旧提供者对象仍可以执行原函数。后两项是本次用法下的默认行为；Cordis 作者可以手动跟踪调用、失效状态和资源归属，不能将示例解释为 Cordis 无法实现安全替换。

在途示例用受控 Promise 暂停函数体。收到停止信号或资源关闭信号后，保持执行门关闭并刷新 128 个微任务，记录资源是否关闭以及替换是否已经结束，再放行函数体。这是有界调度观察，不是所有调度交错的形式证明。隔离源码副本删除实际工作排空后，同一断言必须拒绝提前关闭及替换；该负控制随完整对照运行。任务示例也在相同观察窗口内确认关闭尚未结束，最终明确放行并等待清理完成。

作者代码统一使用同一 TypeScript 编译器、strict 和 noUncheckedIndexedAccess，具体参数随结果保存。Cordis 先使用自己安装的编译器和项目配置生成真实声明文件；这一步没有宣称采用相同构建约束。四个独立错误作者副本分别破坏双方服务输入和事件 payload，必须在修改位置产生语义诊断；导入失败、进程超时和意外终止不能算通过。

结果包含运行环境、源码、解析到的运行依赖、编译器及类型依赖文件、配置和锁文件的指纹，以及真实声明文件指纹。执行结束再次核对。每个子进程有 30 秒上限；临时源码及声明在结束时删除。此次对照不计时，不给代码行数评分，不据此宣称吞吐、内存、整体易用性或高可用领先。
