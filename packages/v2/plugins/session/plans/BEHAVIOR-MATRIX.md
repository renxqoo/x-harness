# Session 行为裁决矩阵

状态：已核销。该项目是新能力实现，旧实现用于识别业务语义，不作为全部行为必须等价的规格。

| 已审阅来源及行为 | 裁决及新验证 |
| --- | --- |
| session/session.test：seq、冻结、输入快照、失败零变更 | 保留；contract/boundaries/transaction-boundaries |
| surface/surface.test：append、跨日志replace、叠加替换、位置逆序 | 保留；contract/projection-properties/transaction-boundaries |
| properties.test：固定随机种子、增量等于重放 | 保留并用独立数组模型核对；projection-properties |
| store/store.test：并发唯一id、fork前缀、血缘及父子隔离 | 保留；contract/process-journeys/boundaries |
| store：恢复header/metadata及历史，释放后旧写入口失效 | 保留会话身份及元数据，新实例继续持久历史；旧服务由core撤销 |
| store：自动cwd、agentDepth/work/worktree等字段 | 不植入中心header；可信宿主或agent插件通过metadata记录 |
| seed end-seed/inherited标记 | 不生成装载过程的伪历史；fork header保存确定来源；agent的处理边界由agent-loop记录 |
| 空源fork失败 | 新契约允许revision0空前缀，显式测试 |
| gates：业务todo、inbox、命令配对及模型thinking等级 | 各自插件定义并校验业务event；session仅校验统一信封及对话数据 |
| gates/snapshot：非法形状、循环、原型、畸形操作 | 保留并增加getter、聚合预算、UTF-8检查；boundaries/snapshot-json |
| 原始reasoning和signature、工具callId | 保存中立内容；LLM回传投影由适配器决定；contract |
| JSONL异步audit、flush监听及drain工具 | 采用数据库事务提交与明确回执；不保留双轨写盘路径 |
| checkpoint：外部操作前确认必要事实持久化 | 上层使用成功回执或getCommit；unknown-outcome与PG failover查证覆盖 |
| 旧运行Session对象关闭后仍可读快照 | 新API返回不可变数据快照，已取得数据可读；旧服务门面失效，恢复通过新实例 |

旧源码、旧测试和旧数据未改动；不提供旧接口或JSONL导入兼容层。新规格增加批次原子性、revision竞争、幂等身份、稳定分页、数据库及实例故障恢复。验收详见[完整记录](../reviews/acceptance.md)。

独立存储拆分以已交付80条会话测试为行为基线，测试归属及装配适配逐条见[存储迁移核销](storage-migration.md)。当前持久化选择由独立后端提供，JSONL后端可按同一公开契约扩展。
