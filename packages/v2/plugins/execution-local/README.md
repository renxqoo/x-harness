# 本地执行

`createLocalExecutionPlugin({profiles,limits?})` 提供 execution 服务，用于宿主明确选择的可信程序。它冻结 argv/cwd/env、验证目标变化、限制输出和并发、监督进程组并清理生命周期。

配置字段与 [sandbox](../sandbox/README.md) 相同，但不能配置 allowedDomains。readRoots/writeRoots 不构成操作系统隔离，restrictions.isolation 明确为 none，网络为 unrestricted；任意命令都保守申请整个 filesystem 的写资源，从而与同一个 tools 实例中的文件声明串行协调。该后端不承诺控制主动脱离进程组的后代。需要文件/网络隔离时安装 sandbox，两个提供者不应同时争抢同一 execution 服务。
