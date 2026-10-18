# 进程执行支撑

execution-local 与 sandbox 共用的 Bun/POSIX 进程生命周期实现。它不自动安装提供者，不登记权限策略；通用插件用户通常只接触 execution 契约和具体执行插件。

createProcessExecutionPlugin 负责 profile 快照、真实路径、环境预算、目标归属与单次消费、并发预算和临时目录清理。具体后端声明 isolation 与 systemReadRoots，并实现 run。runProcess 使用固定 argv/cwd/env，并行写 stdin 与读取 stdout/stderr，绑定取消信号，限制合计输出，等待进程组实际结束后返回。无效配置和普通运行故障返回 Result，不输出系统异常或秘密。
