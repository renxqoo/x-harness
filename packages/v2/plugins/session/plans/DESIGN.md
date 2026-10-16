# Session 设计基线

状态：已核销。工作流：feature-dev-v2，大级新子系统。用户裁决：全新实现，不兼容旧接口；保留历史、有效对话、分支、恢复及不可变快照；默认SQLite，同时支持PostgreSQL共享数据库。

## 契约

Session管理有序不可变历史及从历史确定计算的有效对话。事件不进入对话；消息追加或显式替换有效对话的一个位置区间。替换端点是当前视图节点的seq，按位置而非seq数值大小比较。历史不改写。模型格式转换、压缩生成、工具执行、Agent收件箱及业务状态由其他插件承担。

公开SessionService：create({id,metadata?})、get({id})、append({id,expectedRevision,commitId,entries})、history({id,after?,throughRevision?,limit?})、conversation({id,after?,revision?,limit?})、fork({id,sourceId,throughRevision,metadata?})、getCommit({id,commitId})。方法均Promise<Result<T,SessionError>>，失败字段error，core故障保持原协议。id及commitId由调用者指定，避免结果丢失后创建重复对象。

Entry为event或message。event含type/data，message含中立的role/content及可选replace端点；内容支持text、image引用、tool-call与reasoning。工具结果带callId。session保留推理及元数据，但不决定模型回传规则。所有输入安全读取为JSON快照，访问器、原型异常、循环、非有限数及越界输入拒绝；不执行getter。读取结果深冻结。未知业务event保存，不允许未知结构的对话操作悄悄跳过。

revision等于最后一个历史seq，空会话为0。append由领域验证后委托存储事务锁定会话、检查同commitId、revision及预算（entries至少1条，拒绝空提交，回执条数不超过历史条数），预演全部对话操作后一次提交历史、视图、提交回执和head。相同commitId及相同规范化请求返回原回执（先于revision冲突判断）；不同请求返回commit-conflict。校验、替换、配额或存储失败不留下半批。创建相同id及相同规范化参数返回既有会话，不同参数返回already-exists。

history的after为历史seq，throughRevision必须在0到当前head之间，未来上界拒绝；未指定时固定为当前revision并在回执返回，后续页复用。conversation的after为不透明位置游标，包含revision及最后position；后续页必须使用相同revision，发生写入则revision-conflict，禁止混合不同投影版本。游标格式非法、负值、位置不存在或revision不匹配拒绝；游标自身携带revision，单独revision参数可省略；空页首次请求无游标。不能以seq大小代替位置推进。分页按SQL索引执行，不读取全部历史。成功非终页游标必须严格前进；下一条记录超过本页字节预算时返回record-too-large，不返回无进展空页。配置要求页预算至少单记录预算加固定信封余量；读取已存在的更大记录仍明确报错，不截断。view只保存position/seq，消息正文来自历史，不复制事实。

fork由领域分页读取确定source前缀并重放，存储插件在事务中原子发布，创建独立子会话，按有界页复制前缀并增量重建投影（不整段载入正文）；保留原记录时间及seq，子创建时间独立，header保存来源。父子后续写入互不影响。同目标id及同fork参数幂等。sourceId与targetId必须不同。克隆不执行历史中的外部动作。分支规模超过预算时拒绝并回滚。

## 持久化及失败

SQLite I/O在独立Worker执行，锁等待不得阻塞宿主事件循环；文件模式启用WAL、foreign_keys、synchronous=FULL，所有连接事务受有界串行准入保护，BEGIN IMMEDIATE避免读后升级竞态。跨进程通过数据库锁及唯一键协调。memory只用于显式测试配置。默认路径由插件工厂默认配置提供，生产文档要求显式文件路径。PostgreSQL采用连接池、事务、会话行锁和同一表约束，读使用REPEATABLE READ快照。服务只读写配置的namespace；namespace是宿主分区，不替代用户认证或恶意代码沙箱。

append成功代表数据库事务提交成功；SQLite与PostgreSQL的耐久性受文件系统及数据库复制配置约束。取消/超时/连接中断可能发生在提交之后，因此任何未确认写入都可使用同一commitId重试或getCommit查证，不能断言失败等于没提交。禁止自动重放工具等外部副作用。连接故障不输出连接串/SQL/原始数据库消息；返回storage-unavailable并保留原事务失败传播，不能吞掉异常并提交部分变更。事务内部业务失败通过私有回滚哨兵触发ROLLBACK，公共边界只返回Result。

存储资源在存储插件setup中通过ctx.resource取得，实际服务工作排空后关闭。关闭不删除或永久封存会话；新插件实例可读取并继续提交。无后台持久化队列、会话全局缓存、周期刷新或事件驱动落盘。通知不作为正确性依赖。

## 并发预算

默认单记录1MiB、批次4MiB/128条、每会话100000条/512MiB、有效对话最多10000节点，单页100条/最大1000条且4MiB，输入深度32/节点100000，id/type上限128字节。批次内存和输出页均有界。单插件等待队列64，SQLite同时1个事务，PG默认8个准入事务及8个连接；等待取消后不能执行，事务提交前检查调用signal。数据库锁等待1000ms、PG语句5000ms、连接5000ms；每事务总预算10000ms，在每个查询前及提交前检查，PG另设idle_in_transaction_session_timeout=5000ms。单语句/网络超时与总预算不同，不承诺网络分区下JavaScript实际执行一定立即结束；内核保留actual及资源直到收敛。无定时器随会话数量增长。超额返回capacity-exceeded或busy；不无限排队。配置可显式调小，在硬上限内调大；容量配置只在统一配置文件定义。

## 高可用边界

SQLite用于单机文件持久化及多进程，不支持多个机器共享WAL文件。PostgreSQL用于多节点；主库故障切换、同步复制/RPO、备份、TLS及连接入口由数据库部署负责。插件验证并发及重连结果，不能自行完成数据库集群选主。getCommit/幂等重试用于查证未知提交结果；没有exactly-once外部执行承诺。健康与错误不泄漏凭据。

## 锁及关闭补充

写事务采用READ COMMITTED，PG按namespace/id取得事务advisory锁串行同目标操作；fork只锁目标，不锁源，源历史不可变且不提供删除，读取固定throughRevision前缀不受源追加影响。普通读采用REPEATABLE READ。SQLite在同一连接上串行读写事务，禁止其他读取进入未提交写事务。排队及活动数有界，等待者取消即退出且解绑监听。关闭只关闭插件实例数据库资源，不公开seal/delete；新实例可继续同一持久会话。

## 审查裁决

允许fork到任意已提交seq，包括源批次中间；分支不是重试父事务。不复制父commit回执，子commitId是独立命名空间。fork目标id及规范化来源/前缀/metadata作为创建身份；重复fork返回同一目标，参数不同冲突。

getCommit不存在只表示该事务快照未看到已提交回执，不能证明另一个在途写入不会提交；始终使用同一commitId重试。取消/连接失败仍沿公共Result失败返回，不把阴性查询解释成可换新commitId。

每namespace最多10000会话，metadata最多16KiB；每会话回执数量不超过非空提交记录数量，commitId128字节且只存固定大小fingerprint/seq回执，不复制请求正文。历史字节配额计规范化entry UTF-8；记录信封、索引、回执另受条数及字段上限限制，不宣称等于物理数据库文件大小。namespace持久保存关键配额，其他实例必须使用相同关键配额，避免多节点用不同上限绕过限制。创建计数与数据同事务更新，不依赖进程内计数。

页预算包括整个返回JSON信封的UTF-8字节，不仅正文；预留信封余量，不可容纳一条时明确record-too-large，成功非终页必须推进。fork每次分块的序列化正文不超过页预算，内存还包括这些有界数据的解析/传输副本及最多10000个position/seq投影索引；领域重放受core整次调用预算约束，发布事务有独立预算，失败不发布目标。

独立方案审查7项问题均已裁决：位置游标、未来上界、空提交及回执配额、不可容纳页、fork分块/总期限、分支提交身份、查证阴性含义。对应反例加入验收。

共享token及类型从独立公开contracts入口导出，契约入口不加载数据库运行时。源码及构建产物都引用同一个规范契约模块；构建时将该入口外置，禁止把共享token再打包出第二个身份。根入口组合工厂与同一契约。

存储插件分工与完整契约见[存储设计](storage-design.md)。
