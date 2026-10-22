# JSONL 实施计划

状态：已核销，依赖 DESIGN.md 与 VERIFICATION.md。

## 存量盘点与裁决

| 来源                                           | 结论                             | 动作                                         |
| ---------------------------------------------- | -------------------------------- | -------------------------------------------- |
| session/storage/types                          | 后端无SQL契约已完整              | 只依赖公共入口，接口保持                     |
| session-storage-sql/read-request / read-policy | 纯校验器，无SQL及平台依赖        | 移到session/storage作者工具；不留旧路径别名  |
| session-storage-sql/create-gate                | 纯有界串行准入，取消及排空已覆盖 | 移到session/storage作者工具并迁原测试        |
| session/storage/read-metadata                  | 安全JSON及预算检查               | 复用，不进入消息投影                         |
| session/testing/verify-storage                 | 20项公共一致性检查               | 两独立JSONL客户端运行，不替代真实故障测试    |
| sessionSQL故障/进程装置                        | 真实DB测试不适用于文件协议       | JSONL自有同目录进程探针；现有SQL断言不改     |
| 另一Agent新增并发/伪造后端/边界TDD             | 在途独立工作                     | 只读跟踪，不改其测试，不以其在途失败改弱门禁 |

## 文件组织

工厂和配置；系统锁及资源；安全文件操作；JSONL逐行读取/编码；日志重放和索引缓存；一次提交写入；创建/分支发布；八项存储操作编排。每个文件围绕一个动词，function优先，无代码注释。

## 顺序

1. 方案独立审查及定稿；最小切片实现系统锁、格式、create/commit/read和恢复，写测试后实现。
2. 完整分页、分支、幂等、缓存与预算；运行公共契约及session全链场景。
3. 真进程竞争和SIGKILL、错误/损坏注入、源码及构建入口；四门与覆盖率。
4. 实现独立对抗审查与假绿负控制；逐条处置，原路径核对同步与四门复验。

共享源改动仅为作者工具提取及构建/边界登记。原仓和工作树按路径/哈希核对，绝不覆盖另一Agent的在途文件。core保持不动。默认SQLite保持。

公共存储契约允许同一seq移动position。新增JSONL差分测试发现SQL实现仅按seq集合比较而漏掉位置更新；SQLite与PostgreSQL独立客户端均复现。保留另一Agent已加入的128项删除分批，将比较改为seq→position映射，并增加两个独立重开回归；不修改其测试或在途Lint问题。
