# 会话持久化拆分迁移单元

状态：已核销。

## 行为基线与有意变化

基线：现有80条 session 测试；核心及其他包528条用例不改。会话公开方法、消息模型、返回错误、位置投影、CAS、指纹幂等、固定上界分页、分支与恢复语义保持。

用户裁决的有意变化：createSessionPlugin 不再接受 storage；maxQueue/maxConcurrent/lockTimeoutMs/transactionTimeoutMs 移到存储工厂；应用显式安装存储插件。旧入口和字段删除，不保留兼容。

数据库格式由存储实现负责；不修改已有表结构，不新增数据迁移或导入兼容实现。Namespace settings preserve the existing six-element quota encoding and schema signature. A database created by the baseline implementation must reopen without rewriting records or using a compatibility path.

## 测试迁移矩阵

| 基线文件 | 迁移方式 | 断言处理 |
| --- | --- | --- |
| contract / boundaries / projection-properties / capacity-journeys | 保持 session 包，装配两个独立插件 | 保留业务断言；非法存储配置断言移到存储工厂 |
| storage-faults / postgres-failover / process-journeys | 保持真数据库全链验证 | 只调整工厂装配及子进程参数；未提交崩溃探针直接用各数据库驱动开启事务，避免跨包导入私有SQL库；保留故障与数据终态断言 |
| contract-identity | 同时验证 session 与 storage 的源码/构建token | 保留原断言并增加存储token身份 |
| transaction-boundaries | 领域重放/投影断言留原包，底层取消回滚移SQL库同目录测试 | 保留全部故障断言 |
| unknown-outcome | 移SQL库，在提交前暂停真实事务 | 保留not-found后仍可成功和同ID重试断言 |
| gate / close-worker / sqlite-protocol | 各自移到归属包同目录测试 | 保留全部断言，无跨包引用私有测试文件 |
| snapshot-json | 保留 | 全部保留 |
| 7个类型负例 | 保留，存储配置负例按新领域入口验证拒绝 | 不减少负例 |

## 测试计划

补：未安装存储拒绝启动；领域插件不打开数据库；存储卸载受依赖保护；第三方服务可接入并通过公共契约检查；直接存储CAS/幂等/原子分支/字节边界/垃圾输入/配置冲突；新旧装配断言映射全部核销。

现有真实SQLite多进程、SIGKILL、构建/源码子进程与真实PG同步备库切换全部继续运行。覆盖率阈值保持 statements90/branches88/functions95/lines96，新生产源全部纳入覆盖。

## 回滚

不执行销毁性Git操作。本批按明确路径保存基线；回退代码不需要DDL回滚。命名空间配置不匹配会拒绝启动，不能把更宽配置直接覆盖为更窄策略。部署前按真实数据目录验证契约。

## 验收

- [x] 无SQL/平台模块进入session或core
- [x] 两种独立存储插件及同一公共token
- [x] 会话行为与80条基线测试逐项保持
- [x] 自定义后端契约检查器可复用
- [x] 四门、覆盖率、真实故障旅程及独立审查完成
- [x] 无skip/阈值降低/弱化断言/兼容入口

## 装置适配记录

A1：测试配置对象持有分开的 sessionOptions 与 backendOptions；生产领域类型删除 storage 字段。所有业务断言保持。
A2：底层事务取消/关闭测试转入实现包自己的 __test__，使用本包 value helper；禁止跨包引用 session/__test__。
A3：源码/构建进程探针必须同时选择对应形态的 session 与存储插件入口，避免只验证领域产物而存储一直运行源码。
A4：事务前暂停的未知结果测试直接针对存储 commit，保留真实事务和另一连接查证，不以延迟返回已提交结果冒充在途提交。
A5：领域重放跨多次请求，整次期限沿用core调用预算；数据库事务预算仍为单次10秒。读取分页和分支重放必须在页间观察取消。

R1：独立方案审查发现fork重放顺序缺口。增加“已创建child后源正文损坏仍幂等成功”和“已存在不同origin目标优先already-exists，不被源错误覆盖”回归，领域预查和后端事务内复查同时保留。

R2: Preserve existing storage encoding; test reopening an actual baseline database.
R3: Distinguish defaults from fourfold hard limits; test legal page and projection configurations above defaults.

R4: Add real-database regressions for valid but noncanonical JSON and changed persisted byte counts.
R5: Add replacement-commit replay and changed-content conflict tests after original replacement endpoints are gone.

R6: Runtime review reproduced a false green when fork drops its projection. The public checker now compares copied records including seq/time/body/bytes, parent prefix, metadata and projection references; an independent faulty-backend regression must fail the checker.

R7: Preserve not-found and storage failure precedence over conflicting cursor/explicit revision. Move the cross-revision comparison after the successful storage read and add both-backend missing-conversation regressions.

R8: Self-audit identified malformed head metadata being ignored by history/conversation after extraction. Restore head validation using the shared metadata codec and add both-backend corruption/precedence regressions. Move the generic JSON codec and its unchanged tests to contracts; no alias remains.
