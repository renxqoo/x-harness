# PostgreSQL 会话存储

createPostgresSessionPlugin({ url, limits? }) 提供 sessionStorage 服务，与 createSessionPlugin({ namespace, limits }) 一起安装。存储插件管理连接池，读取使用一致快照，写入使用事务及按目标会话划分的事务锁。

存储 limits 默认 maxQueue=64、maxConcurrent=8、lockTimeoutMs=1000、transactionTimeoutMs=10000；可降低或提高至默认值四倍。会话数据配额由 session 配置，同一命名空间的关键持久配额必须一致。

数据库复制、选主、TLS、连接路由和备份由部署方负责。真实同步备库测试验证确认提交在主库停止及备库提升后可查证，同一插件实例可继续写入；实际部署的耐久性取决于其数据库配置。

公共协议及自定义后端检查方法见[会话指南](../session/README.md)。
