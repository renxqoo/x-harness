# SQL 会话持久化支持库

本库通过显式 Database 事务接口实现 SessionStorage，由 SQLite 和 PostgreSQL 插件复用。openSqlStore 管理准入、事务预算、失败回滚及关闭；createSqlStorage 实现原子持久化操作。

驱动插件负责打开数据库及资源生命周期。本库没有插件注册或驱动选择，core 与 session 均不依赖本库。其他存储后端直接实现[公开存储契约](../session/README.md)。

readStorageLimits 统一校验数据库运行预算，默认 maxQueue=64、maxConcurrent=8、lockTimeoutMs=1000、transactionTimeoutMs=10000，最大为默认值四倍。
