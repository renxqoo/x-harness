# 工具行为审计

状态：已核销。全部保留行为或边界裁决均有以下实现与测试见证。

| 已有行为                                       | 裁决与归属                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| 注册、get、schemas、重名与注销身份保护         | 保留能力；core链登记自动随插件关闭，目录/执行绑定安装身份，冲突失败不挑第一个 |
| 冻结调用者def/schema                           | 改不可变快照，不修改用户对象                                                  |
| TypeBox Kind探活、Errors                       | 改受限JSON Schema和Ajv一次编译；不要求TypeBox符号，不在运行期只检查Kind       |
| arguments回显与throw.message返回模型           | 删除回显；中性设施错误，业务可显式返回isError内容                             |
| preExecute、execute中间件                      | guard承载allow/deny，普通工具作者使用受管入口；策略与审批插件单独实现         |
| permission的direct/contained/escalatable       | 删除基础工具字段；隔离方式与审批授权由具体执行/权限插件定义                   |
| session/sessionDisposed/restrict/restrictionOf | 不耦合会话；列举和执行统一接权限关口，agent-loop负责传递业务上下文            |
| isConcurrencySafe、抛错回落exclusive           | 改数字concurrency，默认1；调度多工具归tool-orch，不能用读写标签代替互斥保证   |
| isControlTool/concludesTurn                    | 不放入执行基础；agent-loop策略负责回合控制                                    |
| kind/readsSubtree/guidance                     | 不内置Read/Write/Danger策略词；描述属于工具说明，权限规则归上层               |
| onOutput无背压                                 | 改await progress，有界预算、并发拒绝、失败锁存和生命周期撤销                  |
| content字符串和additionalContexts              | 改明确文本/图片块+structured JSON，额外会话注入归agent-loop                   |
| isError/aborted                                | isError保留业务失败；取消/超时用Result，不混进成功内容                        |
| agent-loop执行与并行池                         | 仅执行单调用；批调度与模型结果映射不纳入tools                                 |

盘点来源：packages/core/tools/src全部6个实现文件与4个测试文件；packages/agent-loop/src/tool-calls.ts、packages/permission/src/plugin.ts、packages/tool-bash/src/bash.ts。旧包仍有消费者，本任务不删除它们或提供指向它们的别名。

## 验证见证

| 能力或裁决                           | 实现与验证                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| 动态登记/冲突/身份                   | create-tool-plugin、internal、query-catalog；lifecycle/identity/boundaries测试 |
| schema、不可变快照、秘密隔离         | schema/read-schema、compile-schema及domain读取器；schema-data/boundaries测试   |
| 权限扩展与默认拒绝                   | toolAccess、两插件工厂；dependencies/lifecycle/identity及POLICY完整示例        |
| 不耦合session、权限分类/回合控制外置 | check-platform静态依赖门；公共contracts词表和类型夹具                          |
| 数字并发与实际结束占槽               | 两插件工厂、run-tool；concurrency测试、提前释放容量突变                        |
| progress背压、预算、撤销、GC         | create-progress；progress、progress-retention及3种突变                         |
| 明确content/structured/isError       | read-output；schema-data、README及类型夹具                                     |
| 单次执行与模型层分离                 | ToolsService三个方法；依赖边界门、独立真实HTTP新进程旅程                       |
