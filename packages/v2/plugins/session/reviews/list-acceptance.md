# 会话发现交付验收

状态：已核销。2026-10-17。在原工作目录 packages/v2 验证。

## 交付

统一提供 session.list({ after?, limit? })，不需要预先知道ID即可发现持久会话。返回id、createdAt、metadata及可选parent摘要和next游标。按ASCII ID升序，namespace隔离，每次读取一致，跨页使用无服务端状态的游标。get读取当前revision及bytes。SessionStorage增加必需list方法，SQLite、PostgreSQL、JSONL及公共检查器同步落实，core源码未改变。

公开层校验不可信后端的形状、顺序、父引用、数量、游标和实际UTF8页字节，不执行数组访问器。存储作者工具统一安全摘要校验及保守组页预算：1024字节信封预留，每项512字节固定预留加两倍metadata字节；这是上限控制，不保证将每页填满。SQL最多32行一批，只查询头索引；PG明确C排序并建对应索引，SQLite使用BINARY。JSONL在现有锁、队列、取消及期限内枚举有界目录，逐个读取并校验头部，不重放正文或新增持久索引。

JSONL路径使用小写base32编码，解决大小写不敏感文件系统的会话及namespace身份冲突，并支持128字节ID。根格式标记确认路径编码，不匹配已有目录被拒绝，文件保持原样；没有兼容回退或自动数据迁移。摘要发现不等于完整历史体检。

[行为矩阵](../plans/BEHAVIOR-MATRIX.md)补齐遗漏裁决：持久会话发现保留，进程内活跃Agent对象枚举归属运行时。旧检查断言保留，接口实现和文档同时更新。

## 四门

在 /Users/wrr/work/x-harness/packages/v2 运行 bun run lint、bun run typecheck、bun run build、bun run test，均成功。Lint零错误零警告，103个内核源码及140个外围源码通过边界检查；122个类型负例按预期拒绝，31个文档示例通过公开API检查。构建包含三种存储插件，测试包括源码与构建入口的真实进程旅程。

103文件，751/751用例通过；新增23例，公共存储检查从20项扩展为25项，检查断言不另计为用例。JSONL为10文件57例。测试worker上限8，以匹配隔离PostgreSQL的64连接容量；未改数据库连接上限、测试期限或有效断言。

| 指标 | 覆盖率 | 覆盖/总量 | 阈值 |
| --- | --- | --- | --- |
| Statements | 93.38% | 5153/5518 | 90% |
| Branches | 91.45% | 3608/3945 | 88% |
| Functions | 97.93% | 902/921 | 95% |
| Lines | 98.33% | 3188/3242 | 96% |

覆盖率来自原目录coverage/coverage-summary.json，没有降低阈值、扩大排除、新增skip或删除断言。机器记录及交付文件指纹见[list-verification-results.json](list-verification-results.json)。

## 行为证据

| 场景 | 测试 |
| --- | --- |
| 三后端重开、未知ID、ASCII顺序、namespace及并发创建 | session/src/__test__/list.test.ts |
| 大集合UTF8字节预算、128字节ID/namespace、257字符游标 | session/src/__test__/list.test.ts |
| 不可信返回、访问器、重复/乱序/不推进、父引用、显式undefined | session/src/__test__/list-forged.test.ts |
| 三后端源码/构建入口在独立进程发现未知ID及分支 | session/src/__test__/list-process.test.ts，6例 |
| 只读头部、坏正文/坏头、编码身份及格式拒绝不改写 | session-jsonl/src/__test__/catalog.test.ts |
| 公共作者契约及请求形状 | session/storage检查器、request.test.ts及三后端公共检查 |

[独立审查](list-review.md)未发现确定缺陷，额外微复现81组SQLite分页边界、10000组base32随机往返、3例伪造页拒绝，JSONL大小写/namespace/坏头/取消与句柄生命周期均通过；关闭后句柄归零。

[8项新接口突变](list-mutation-results.json)均被行为断言检出：SQL namespace隔离、SQL游标推进、公开游标namespace、摘要排序、页预算、next身份、文件大小写身份、格式识别。脚本[check-list-mutations.py](check-list-mutations.py)仅改隔离临时副本；要求有实际失败和通过用例、无运行时套件加载错误，不以导入失败充当检出。

JSONL原8项突变亦重跑成功，CAS、指纹、摘要、同步、分支前缀、尾恢复、快照基线及发布取消原断言保持；独立运行探针106条断言通过，revision4136、receipts49、bytes627326。

## 验证边界

实测macOS arm64、Bun1.4.3及真实隔离PostgreSQL/SQLite。Linux/glibc需目标环境验证；没有硬件断电实测。JSONL面向本机进程协调，多节点使用PostgreSQL。跨页不是冻结目录快照；并发新建大于游标的ID可出现在后页，小于游标的ID需重新从首请求发现。没有对跨页强快照、任意过滤或总量统计作保证。未运行e2e/main.ts，未push或publish。
