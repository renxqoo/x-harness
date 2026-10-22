# 调度行为审计

状态：已核销。既有packages/agent-loop/src/tool-calls.ts把调度、模型JSON参数解析、会话落盘和结果截断混合；本任务不复制实现，不提供兼容字段。

| 行为                              | 裁决                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| 批量执行与maxParallel             | 保留能力，移为通用batch/concurrency及每工具并发，新增跨调用者公平性         |
| 模型arguments字符串、截断参数判断 | 调用者负责解析成对象；调度器只接受完整JSON对象                              |
| 按输入顺序保存结果                | batch报告按输入顺序，完成顺序不影响结果关联                                 |
| 会话append与turn/step             | 归agent-loop及session，调度不写会话                                         |
| allowedTools与审批                | 默认toolScheduleAccess准入及执行前重查，tools最终独立授权                   |
| additionalContexts、concludesTurn | 归agent-loop语义，不进入通用工具调度                                        |
| onOutput忽略回调错误              | progress必须等待，复用tools背压与消费者错误                                 |
| 字符截断、synthetic结果           | 结果设明确累计字节预算，超额返回capacity-exceeded，不静默截断或合成业务输出 |
| 取消任务                          | core受管任务，排队节点撤销，运行节点实际退出前保持容量                      |
| 依赖与优先级                      | 新能力：显式DAG、失败隔离、lane轮转及同lane有限优先级连胜                   |

验证见证：batch.test覆盖批量顺序、失败及isError后代隔离、非法图原子拒绝；queue/lifecycle覆盖等待、立即拒绝、实际结束、取消/期限、卸载、容量及无重试；fairness覆盖调用者轮转、优先级防饥饿及不同工具不头阻塞；permissions覆盖默认拒绝、deny优先、原始origin、委托身份、撤权重查及批内元数据快照；validation/progress覆盖预算、垃圾输入、快照、公开结果检查、背压和秘密隔离；retention及scheduler-built进程旅程覆盖GC、构建共享身份、真实HTTP并发、依赖完成时序和取消排空。
