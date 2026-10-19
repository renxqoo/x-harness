# Agent loop 施工图

状态：已核销。

## 存量审计

core：只提供普通服务、chain、guard、event、受管调用与任务；不修改业务。
llm：公开 llmRequest 支持 collect=true 同时取得原流与最终有序 content，避免重新实现厂商流解析。沿用请求/返回验证，公开 llm/validation 包装已有请求/结果校验而不引用私有模块。
tools：公开目录及 tools/validation；tool-scheduler：公开 batch，已有资源协调与权限，不复制调度。tools/validation 增加复用现有 schema 编译的纯输入校验，提交前整批相对目录验证，节点执行时仍重新校验。
session：消息投影无法承载所有 continuation/引用；检查点以 session event 持久化完整 LLM 数据，不能有损强塞到 SessionMessage。数据库在外部插件，loop 不依赖 session。
旧 agent-loop：参考完整工具成对回填、延迟执行与取消的行为；不保留 Session 对象、system-prompt 依赖、inbox、专用工厂扩展回调或静默截断。

## 模块与依赖

plugins/agent-loop 分为 contracts、domain（有界读取/映射）、runtime（编排/事件/检查点）、stream。只依赖 core、llm、tools、tool-scheduler 的公开入口。契约独立入口与构建产物共享 token 身份。跨包 llm/调度器/agent-loop 的公开 index 也作为共享入口外置，避免业务实现被重复打包及通配重导出的未绑定命名空间；源码/构建旅程验证这一边界。新增包名、构建、边界检查和类型检查接入现有工作区；覆盖率门槛不变。

## 批次

1. 最小正式垂直切片：公开 run/context/checkpoint/event 契约、纯文本流完成及取消，单测与四门、独立审查，校准方案后继续。
2. 工具循环：全批校验、历史 ID、顺序/并行工具、错误配对、continuation、硬预算与继续关口，公开插件示例。
3. 惰性流、生命周期与异常专项，源码/构建混合与回环 HTTP 模型 + SQLite 检查点旅程。
4. 独立对抗审查、变异检出、基准与覆盖率、文档类型校验、逐条核销。

不并行写实现。独立审查只读。合入前检查主工作区路径 SHA，不覆盖其他改动；只提交本任务点名文件。
