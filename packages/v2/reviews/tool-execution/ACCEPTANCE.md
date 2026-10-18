# 工具执行链路验收

日期：2026-10-19。状态：已核销。工作树与主目录四门均通过。

交付：可插拔效果权限、资源读写协调、分阶段工具调度、不可变执行目标、显式本地执行、基于 @anthropic-ai/sandbox-runtime 0.0.77 的 macOS 单进程沙箱。审批管理、界面、LLM 判权业务由用户插件实现。

逐文件 SHA 校验合入 132 个任务文件，没有并发内容冲突或文件删除。主目录使用冻结锁文件离线安装依赖，再重新执行 lint/typecheck/build/test，结果与工作树一致。未执行 commit、push 或 publish。

## 验证结果

| 检查 | 实际结果 |
| --- | --- |
| lint | 0 error / 0 warning；104 个内核文件、302 个外围源文件通过边界检查 |
| typecheck | strict 通过；165 个编译负例被拒绝，38 个文档/公开入口正例通过 |
| build | 所有包及 sandbox-worker 构建成功 |
| test | 166 文件，1488 用例通过，原有 1316 个用例及断言保留 |
| coverage | statements 91.06%、branches 89.81%、functions 97.72%、lines 98.39%；门槛仍 90/88/95/96 |
| 真实过程 | source/dist 双向组合，策略 → 调度 → 工具 → SRT 命令与结果；允许/拒绝网络并发、只读/写入、别名、派生进程拒绝及取消排空 |
| GC | 保留关闭的 prepared/commit/watch/facade，消费者仍可回收；有正常 GC 对照 |
| 负控制 | tools 11、scheduler 8、execution 10，共 29 项全部被行为断言检出，无导入失败或用例超时冒充检出 |

覆盖率较基线 92.25/90.32/98.41/98.47 下降；增加了跨进程实现与测试，没有降低门槛或忽略文件。子进程真实旅程的执行不能自动计入当前 Vitest 进程覆盖率，不把全局数字当作进程内外逐行安全证明。

## 可重复运行

在 packages/v2 执行 bun run lint、bun run typecheck、bun run build、bun run test；专项负控制使用 test:tools:mutations、test:scheduler:mutations、test:execution:mutations；基准使用 benchmark:tools、benchmark:scheduler、benchmark:execution。后两类输出保存在对应 reviews JSON，负控制只修改临时副本。

## 本机观察

| 场景 | 中位耗时 | 实际执行峰值 |
| --- | --- | --- |
| 32 个共享读任务 | 14.036 ms | 8 |
| 32 个冲突写任务 | 47.422 ms | 1 |
| 32 个权限等待任务 | 32.286 ms | 2 |
| 单次本地 true 命令 | 1.648 ms | 1 |
| 单次 SRT true 命令 | 106.624 ms | 1 |

批次工具模拟 1ms 工作、权限场景模拟 5ms 等待；权限检查峰值 32，执行峰值 2。SRT 每条命令包含独立 worker 启动和回收成本。Bun/平台/全部样本及生产来源 SHA 在 benchmark.json 中；不声称其他框架、远程延迟或跨机器可用性比较。

## 边界与基线问题

沙箱默认拒绝 fork，不能运行管道、后台多进程或要求子进程的程序。需要这种隔离时通过 execution 服务接入其他后端；local 只用于可信程序。进程内插件和同 UID 的外部文件写入者属于可信计算基；资源锁只覆盖同一个 tools 实例。

一次全量出现既有 loader 自动 watch 恢复失败；完整基线和当前代码各 120 轮均复现 1 次，专项与随后全量通过，不把它解释为已修复。本轮没有修改 loader/application。定位与证据见 REVIEW.md。
