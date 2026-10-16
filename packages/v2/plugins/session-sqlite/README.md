# SQLite 会话存储

createSqliteSessionPlugin({ path?, limits? }) 提供 sessionStorage 服务，与 createSessionPlugin({ namespace, limits }) 一起安装。默认路径为 ./data/sessions.sqlite；显式 :memory: 使用临时内存数据库。

每个实例由独立 Worker 管理一个 SQLite 连接，启用 WAL、FULL 同步及外键。支持本机多进程事务协调，关闭时等待实际在途事务排空，再关闭连接和 Worker。

存储 limits 默认 maxQueue=64、maxConcurrent=8、lockTimeoutMs=1000、transactionTimeoutMs=10000；可降低或提高至默认值四倍。SQLite 实际事务并发固定为1。会话数据配额由 session 配置，同一命名空间的关键持久配额必须一致。

本后端的部署范围为本机文件存储。多节点应用使用共享数据库后端。公共协议及自定义后端检查方法见[会话指南](../session/README.md)。
