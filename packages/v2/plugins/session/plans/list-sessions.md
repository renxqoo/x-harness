# 会话发现与分页枚举

状态：已核销。级别：中。工作流 feature-dev-v2。

## 契约

用户裁决：补齐上一轮讨论的持久化会话发现能力；不恢复旧对象生命周期接口，不将Agent运行状态放入Session。

SessionService.list(input: ListSessions) 返回 SessionResult<SessionListPage>。ListSessions仅含after?和limit?，使用list({})，对象内字段均有默认值，符合内核单输入签名。返回sessions数组及可选next。SessionSummary包含id、createdAt、metadata、parent，不包含当前revision和bytes；get仍返回完整当前状态。

固定按ASCII字节序id升序。公共after为绑定当前namespace的opaque游标，next来自最后返回的id；不同namespace游标、非法形状、非正limit、超配置上限均invalid-input。默认limit使用pageSize，上限maxPageSize，返回信封总UTF8预算使用maxPageBytes。空集合成功且没有next；有下一页必须返回非空、严格推进的next。首条无法容纳时record-too-large。结果深冻结。

SessionStorage增加list({namespace,after?,limit,maxPageBytes})，after/next为原始id，返回StoredSessionSummary数组，metadata仍为存储字符串。所有实现必须支持；不增加可选兼容路径。公共摘要读取器校验形状、metadata和父引用，公共组页工具统一预算/顺序/推进规则。Session再次校验后端返回形状、数量、顺序、游标及总预算，不信任替身后端。安全复制数组数据属性，逐项累计实际公开JSON字节，避免先复制超预算整页；接口允许可选字段显式undefined，统一省略输出。

## 一致性与预算

每次请求在后端一致读取范围内完成；跨页不持有事务、不创建服务端游标或后台任务。并发创建大于after的id可出现在后页，较小id从首请求重新枚举；已有ID不会因append/fork源更新或日志整理而改变顺序。after无需引用仍存在的id。当前模型没有删除。

SQL使用现有会话头表，仅取不可变摘要字段；WHERE namespace与after、LIMIT均参数绑定；每批最多32个摘要，读到limit+1个候选即可判断后页。Query增加textCollation枚举能力：SQLite BINARY、PostgreSQL C；排序、比较和索引均使用同一字节序，避免生产数据库locale改变分页顺序。创建(namespace,id COLLATE C)的索引以供PG查询，SQLite使用BINARY索引。SQL适配器及测试装置显式声明，不猜测后端。

JSONL在现有根OS锁、队列、取消和操作期限内完成。目录条目数受持久maxSessions约束（硬40000）；检查名称后按ASCII排序，只读取最多limit+1个候选的校验头行，不调用load/replay、不创建第二份持久索引。单头编码预算6*maxMetadataBytes+8192，流式64KiB；每步检查signal和期限，句柄finally关闭，成功观察的摘要文件及祖先目录完成sync。摘要不承诺整个历史正文健康，history/conversation读取记录正文时执行相应校验，get读取当前状态。头部损坏明确storage-corrupt，不静默遗漏。已有fork/snapshot强制完整基线的读取行为不变。

每页最多4000+1候选，SQL按最多32行分批读取，批次metadata的UTF8载荷最多2MiB（不等同于JavaScript堆字节），返回空间受16MiB页硬限约束，JSONL逐个读取，返回仅持有页预算内摘要。不会全量载入历史。复用现有队列/事务/OS锁预算，不新增定时器。

## JSONL路径身份

混合大小写测试确认macOS大小写不敏感文件系统会将A与a视为同一文件，namespace亦然。统一采用UTF8小写base32编码（128字节ID最多205字符，加扩展名不超过常见255字节文件名限制）namespace及会话文件名，目录枚举严格校验编码往返，不增加别名或回退读取。根格式标记包含paths=base32以拒绝不匹配布局；不会自动迁移或改动已有不匹配目录。用户既有裁决是不保留旧路径兼容代码。无新增持久索引或双轨事实。原故障装置路径随同迁移，原断言保持，另增加跨namespace及casefold回归。

## 问题域与拆分

session负责namespace配置、公开游标、摘要值与领域校验；session/storage公开backend形状及摘要校验/组页工具；SQL库和JSONL实现物理读路径。core不变。Agent活跃实例由运行时管理；搜索、任意metadata过滤、按更新时间排序、总量统计、跨namespace管理及跨页强快照不在本接口范围。

行为审计纠正：旧SessionStore.list枚举进程内运行对象，不沿用其生命周期语义；旧SessionArchive.list/listHeaders的持久会话发现由此分页接口承担。旧按父会话/agentId检索等业务逻辑由上层读取摘要metadata后处理，不在Session固化Agent字段。

## 实施与验证

1. 三后端领域红测；补公共契约与类型、共享摘要校验及游标操作。
2. SQL字节序查询和适配器、JSONL仅头读取；内存契约实现和既有装置显式适配，全部原断言保留。
3. 三后端重开、多页、混合大小写/标点、namespace、并发插入、字节预算、损坏与伪造后端矩阵。JSONL验证损坏正文不被列表重放、摘要损坏失败、只读头行及句柄关闭。复用真实源码/构建子进程旅程验证重启发现未知ID。
4. 全量回归出现103个worker同时访问max_connections=64的隔离PG，确认连接容量耗尽及CPU调度造成时限波动；固定测试worker上限8，保留所有断言和期限，不提高数据库连接阈值。
5. lint/typecheck/build/test及覆盖率阈值90/88/95/96保持；独立对抗审查，确认问题带回归；隔离负控制检查namespace、after、next、预算。

## 验收

- [x] 契约、三后端及公共检查器一致
- [x] 重启发现、并发分页及损坏边界
- [x] 资源/返回/读取预算与生命周期
- [x] 行为矩阵、当前使用文档、示例类型检查
- [x] 四门、独立审查与负控制，实际数字落档

验收数字、独立审查与负控制证据见[交付记录](../reviews/list-acceptance.md)。
