# 存储插件拆分施工图

状态：已核销。设计见 storage-design.md；行为与测试基线见 storage-migration.md。

## 审计结论

G1：operations 内嵌 SQL，Query.all 是 SQL 方言端口，无法直接实现文件后端。
G2：createSessionPlugin 同时持有领域配置和数据库资源，插件生命周期尚未解耦。
G3：SQL 适配器的事务、限流、Worker、失败回滚与真实故障测试已覆盖，复用这些机制。
G4：fork 领域重放与 SQL 插入共处事务；拆分后必须明确不可变前缀和原子发布协议。
G5：现有80条测试为行为基线，装配和私有实现测试需要调整归属，不能减弱断言。

## 文件裁决

| 文件 | 裁决 | 审计依据与目标 |
| --- | --- | --- |
| contracts/define-session.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| contracts/types.ts | 重构 | 已审计；G2：领域配置和存储配置分离，规范化公共入口 |
| contracts.ts | 重构 | 已审计；G2：领域配置和存储配置分离，规范化公共入口 |
| create-session-plugin.ts | 重构 | 已审计；G2：领域配置和存储配置分离，规范化公共入口 |
| domain/fail.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| domain/fingerprint.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| domain/project-entries.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| domain/read-entry.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| domain/read-input.ts | 保留 | 已审计；领域校验、投影、JSON预算与会话token语义不变 |
| domain/snapshot-json.ts | 迁移 | R8: contracts/snapshot-json.ts; shared bounded JSON codec, unchanged behavior |
| index.ts | 重构 | 已审计；G2：领域配置和存储配置分离，规范化公共入口 |
| operations/append-session.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/create-session.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/fork-session.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/get-commit.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/get-session.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/read-conversation.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| operations/read-history.ts | 重构 | 已审计；G1/G4：删除SQL，以存储服务编排；保持行为分支 |
| read-options.ts | 重构 | 已审计；G2：领域配置和存储配置分离，规范化公共入口 |
| storage/create-gate.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/create-head.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/initialize-store.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/insert-records.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/open-postgres.ts | 迁移 | 已审计；G3：session-postgres，连接及事务隔离行为保持 |
| storage/open-sqlite.ts | 迁移 | 已审计；G3：session-sqlite，Worker协议及资源关闭行为保持 |
| storage/open-store.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/persist-projection.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/read-head.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/read-receipt.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/read-record.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/select-page.ts | 重构 | 已审计；G1/G3：session-storage-sql，保留事务预算与回滚；移除领域算法依赖 |
| storage/serve-sqlite.ts | 迁移 | 已审计；G3：session-sqlite，Worker协议及资源关闭行为保持 |
| storage/sqlite-worker.ts | 迁移 | 已审计；G3：session-sqlite，Worker协议及资源关闭行为保持 |
| storage/types.ts | 重构 | G1: public persistence contract; SQL Query/Database/Store belong to session-storage-sql |

## 实施顺序

1. 契约及 SQLite 的 create/read/commit 垂直切片，补依赖装配与直接存储契约测试。
2. 完整读取/分页/分支；接入 PostgreSQL，共享事务支持库；移除 session/storage 私有SQL文件。
3. 迁移全部80条行为用例和类型负例，补第三方后端检查器、生命周期与契约故障回归。
4. 四门、独立对抗审查、真数据库/双形态进程/同步备库切换、无静音抽查。

构建与平台边界检查新增包；session 采用浏览器目标验证领域包无平台依赖。存储驱动按 Bun 目标构建，SQLite Worker 单独打包。
