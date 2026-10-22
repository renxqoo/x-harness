# Session 施工图

状态：已核销。依赖[设计基线](DESIGN.md)。

## 审计及裁决

| 来源                                        | 保留的业务语义                                          | 实现裁决                                                    |
| ------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| packages/core/session/src/session.ts        | 不可变历史、输入快照、写入失败零变更                    | 重写为事务服务，不返回可变Session句柄                       |
| packages/core/session/src/surface.ts        | append/replace、日志和对话分离、确定重放                | 重写独立投影函数及索引视图；端点按位置校验                  |
| packages/core/session/src/store.ts          | 唯一id、fork前缀、恢复原身份、父子隔离                  | 重写持久会话；不把释放实例等同封存数据                      |
| packages/core/session/src/types.ts/gates.ts | 中立消息、运行输入检查                                  | 重写；业务event不收进中心联合；LLM配置、todo、inbox归各插件 |
| packages/session-persistence-jsonl/src      | 持久化失败可见、关闭排空、归档恢复                      | 不复制JSONL及异步audit写盘；采用数据库提交路径              |
| packages/session-checkpoint/src             | 外部动作前确认必要事实已保存                            | 成功提交回执直接证明本次保存；检查点策略留上层              |
| `packages/core/session/src/__test__`        | replace嵌套、日志交错、快照、fork、垃圾输入、并发唯一id | 重写为新公开API行为及确定性重放测试；不修改旧测试           |

## 组织

src/contracts公开数据/服务定义；src/domain纯投影和输入快照；src/storage纯存储契约；SQL实现位于session-storage-sql，驱动和资源位于session-sqlite/session-postgres；src/operations一操作一文件；create-session-plugin编排存储依赖和领域服务。仅使用core公开index/validation；DB依赖属于插件，core不改变。

## 实施顺序

1. 三件文档及独立对抗审查，修正规格问题后定稿。
2. 记录/投影、SQLite全事务实现和正式首个垂直切片：创建→批次提交→分页读取→重启继续。完整四门及独立审查。
3. 分支、恢复、幂等查证、PG适配器，运行同一契约矩阵与多客户端竞争。
4. 真进程崩溃、跨进程竞争、数据库连接中断/重启、源码与构建入口冒烟。对抗故障注入，完整门禁、覆盖率及交付核销。

不复制旧源码、不改旧包及其数据。没有存量数据回填，SQL初始化只创建独立xh_session_*表，结构不匹配拒绝；不会自动删除表或重写用户数据。新数据回滚需要保留数据库文件/表及匹配程序，不能用降级代码解释未知结构。
