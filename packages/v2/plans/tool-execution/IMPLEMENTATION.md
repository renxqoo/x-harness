# 工具执行链路施工图

状态：已核销。

1. 定稿前审查：独立会话仅阅读方案和现有公共边界，反证竞态、越权和生命周期。
2. 垂直切片：tools 准备、权限扩展与资源协调，scheduler 仅准备依赖就绪节点并按 ready 选取；补权限等待不占名额、直接调用不可绕锁、取消不早释锁回归，执行四门和独立审查。
3. 执行插件：execution 契约、local 和 macOS 提供者；冻结目标、命令监督、输出预算、沙箱 profile 与真实进程旅程。
4. 接入：ToolInvocation.execution 单次受控执行、沙箱资源自动声明、源代码/构建产物身份一致、公共导出和平台依赖检查。
5. 收口：边界矩阵、恶意输入、许可撤销、GC、动态安装、跨调度器资源竞争、真实沙箱权限越界、取消进程与后代；独立对抗审查、负控制、四门、基准、README 和数字验收。

实现工作树 /Users/wrr/.codex/worktrees/plugin-api/x-harness。变更前 SHA 基线 /tmp/tool-execution-chain-baseline/manifest.json。只回写本任务点名文件；检测主目录同路径并发变更再协调，不覆盖他人修改。不 push。

## 实施落点

- core 只提供 originId/originSignal/initiator/remainingMs 通用元数据。
- execution 定义目标与资源单一契约；execution-process 支撑进程型提供者；execution-local 与 sandbox 分别提供显式本地和 SRT 执行。
- tools 的 planning 目录统一处理准备、许可、意图、资源与容量提交；关闭句柄工厂隔离可回收作用域。
- tool-scheduler 分 prepare/check/commit 调度，使用 tools.watch 与 revision 等待变化；异步业务检查不占执行槽。
- fixtures/execution-built-case.ts 完整贯通真实 SRT 进程及源码/构建产物身份；旧用例与断言全部保留。
- README 与 EXECUTION 示例、编译正负例、变异门和基准一同交付。不实现审批管理、LLM 判权业务或分布式队列。
