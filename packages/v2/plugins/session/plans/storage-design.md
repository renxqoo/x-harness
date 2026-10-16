# 会话与存储插件设计

状态：已核销，独立方案审查R1-R5已采纳。

## 1. 裁决与边界

用户裁决：session 独立于持久化；SQLite 为默认选择；PostgreSQL 支持多节点共享数据库；用户后端可独立实现；不保留内嵌 storage 配置和兼容入口。

session 保留 create/get/append/history/conversation/fork/getCommit 的公开行为，负责输入快照、消息校验、指纹、投影与分支前缀重放。session 不导入平台模块、SQL 实现或数据库驱动。SHA-256采用Web Crypto异步摘要，规范请求身份保持。

session/storage 是唯一存储服务 token 和类型入口；存储保存不可变记录、投影索引、会话头和提交回执，不解释消息结构。session/contracts 保持会话公开契约入口。两个入口均保持源码与构建身份一致。

session-sqlite 与 session-postgres 分别提供同一个 sessionStorage token，分别管理 Worker/文件和连接池。session-storage-sql 是二者复用的 SQL 事务实现库，不是插件，也不进入 core。其他后端无需依赖此库。

本批交付两种已有真实后端、公开存储契约及可复用契约检查器。JSONL 是后续独立后端，当前不导出占位插件，不承诺其多节点能力。应用显式安装选中的存储插件及 session；SQLite 工厂缺省路径为 ./data/sessions.sqlite，session 不隐藏创建数据库。

## 2. 存储服务

initialize(namespace, policy)：持久化六项关键配额，保持现有 schema 签名和数组编码；配置不同明确拒绝。policy 包括 maxRecordBytes/maxSessionBytes/maxRecords/maxConversationNodes/maxMetadataBytes/maxSessions。无命名空间缓存。

read(namespace,id,commitId?,projection?)：单一快照返回会话头、可选现有提交、可选投影索引。metadata 是有界 JSON 字符串，读取会话头时必须先验证其 JSON 完整性；记录正文是有界不透明字符串，由 session 验证消息结构和规范串。共享 readStorageMetadata 编解码检查器供后端复用。

create(namespace,id,origin,metadata)：按目标 ID 串行化，同一来源幂等；与命名空间数量计数原子提交。

commit(namespace,id,expectedRevision,commitId,fingerprint,records,nodes)：先查提交身份，再检查预期版本；记录、完整目标投影、回执和会话头一次事务提交。相同提交身份内容相同返回原回执，不同指纹返回 commit-conflict。节点只包含 position/seq，不带可执行回调。

history(namespace,id,after,throughRevision?,limit,maxPageBytes)：单一快照返回固定上界及按字节与条数限制的原始记录页；检查连续性和未来上界。

conversation(namespace,id,position,revision?,limit,maxPageBytes)：同一快照检查版本与游标位置、读取投影索引关联的原始记录；session 生成并验证对外游标。

fork(namespace,id,origin,metadata,sourceId,throughRevision,bytes,nodes)：session 首先查目标，存在时按origin幂等返回或already-exists，不读取源；目标不存在才分批读取不可变前缀并重放投影；后端在目标锁下复查目标幂等身份、源前缀和总字节，原子复制记录并发布目标头/投影/计数；不复制父回执。源记录不可修改，使重放与发布之间的新追加不影响该前缀。失败不得遗留目标或占用数量。

getCommit(namespace,id,commitId)：返回指纹和提交回执；not-found 只是当前观察，不证明其他在途提交不会成功。

输入先做无getter快照校验：标识符、整数字段、记录条数/总字节、节点唯一性和顺序都必须检查；正文是有界UTF-8字符串，存储不解释JSON消息。服务不允许事务回调、SQL、游标句柄、连接、Worker 或文件句柄逃逸。所有调用均返回 SessionResult；底层错误细节不泄漏。取消、调用失败或失联可能发生在提交后，调用方应以同一 commitId 重试。

## 3. 依赖与生命周期

session requires storage，存储 provides storage。session setup 通过受控依赖 initialize；运行中的每个方法通过 call.deps.storage 调用，继承取消和 core 的依赖停机保护。session 不保存数据库资源。数据库资源由提供方 ctx.resource 管理，关闭等待实际在途事务退出；动态卸载遵守 core 依赖关系，不能原地替换底层服务对象。

领域 SessionLimits 只保留记录/批次/会话/投影/元数据/分页配额；存储配置单独持有 maxQueue=64、maxConcurrent=8、lockTimeoutMs=1000、transactionTimeoutMs=10000。SQLite 事务并发固定为 1，PostgreSQL 最大为 maxConcurrent。所有数字保持现有默认与四倍上限，领域相关约束保持。

Namespace policy is read inside each transaction. Projection defaults to 10000 nodes, with a hard limit of 40000. Page defaults are 4MiB/1000 records, with hard limits of 16MiB/4000 records. fork 重放只持有一页和投影，数据库端复制不把完整历史载入 JS。完整目标投影作为提交输入有条数上界，SQL 更新仍按增量差异持久化。跨多个存储请求的领域操作继承core整次调用的deadline/signal；每个数据库事务继续有10秒预算。fork每页间检查取消，不把多个事务预算误写成整次操作预算。

## 4. 一致性与部署

所有后端都必须满足原子提交、CAS、幂等身份、稳定读取、原子分支、可见损坏以及关闭排空。高可用部署能力取决于后端和实际部署。SQLite 保持本机多进程事务与崩溃恢复；PostgreSQL 保持多节点访问和已部署同步备库的确认提交恢复。数据库复制、仲裁和路由由运维部署负责。

自定义后端实现 sessionStorage 服务并运行公共契约检查器；不需要实现或导入 SQL 支持库。检查器验证基础 CAS/幂等/快照/分支保证；真实进程崩溃、持久化和集群故障切换仍须各后端自身测试证明。

## Review decisions

R4: Domain record decoding preserves canonical JSON equality and exact persisted UTF-8 byte equality, in addition to JSON/message validation.
R5: append handles an existing receipt before CAS, quota or projection validation. read skips projection loading when the requested commit already exists, preserving idempotent replay even after replacement removed its original endpoints.

R8: Metadata validity is part of the storage head contract. The public metadata decoder reuses the safe JSON snapshot codec; all SQL head reads validate it before revision, position, or paging errors. Receipt-only reads remain independent of head metadata.
