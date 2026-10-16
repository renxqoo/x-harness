# JSONL 会话存储设计

状态：已核销。工作流 feature-dev-v2，大级持久化子系统。用户裁决：独立 JSONL 存储插件，实现现有 SessionStorage；默认后端仍为 SQLite；不添加历史接口或导入兼容代码。

## 公共契约与部署范围

createJsonlSessionPlugin({ path?, limits? }) 返回 SessionResult<Plugin>，提供规范 sessionStorage token。默认目录 ./data/sessions-jsonl。limits 仅包含 maxQueue=64、lockTimeoutMs=1000、operationTimeoutMs=10000，正整数，可降至1或提高至默认四倍。当前部署目标为本机 macOS 或 Linux/glibc，运行时 Bun。其他平台或无法取得系统锁明确返回 configuration-conflict/storage-unavailable；不使用过期时间接管锁。多机共享网络文件系统、复制与选主由其他后端承担。

保持 initialize/read/create/commit/history/conversation/fork/getCommit 形状、错误及幂等语义。领域投影算法不进入本插件。metadata 是有界 JSON，复用公开解码器；记录正文按存储契约保持不透明字符串。session 与 core 不导入本后端。

## 数据布局

目录由插件独占：format.json、store.lock、pending.jsonl、namespaces/<namespace>/policy.json、namespaces/<namespace>/sessions/<id>.jsonl。标识符来自统一契约验证器。新目录0700、数据和锁文件0600。拒绝符号链接及非普通日志文件，文件打开使用 O_NOFOLLOW。根无format时只允许store.lock及pending.jsonl两个保留名；锁内清理pending并原子发布format，完成各级目录sync，恢复首次初始化死亡。其他无格式非空目录拒绝。namespace无policy时仅允许空目录；policy经根pending原子发布并同步祖先后，才创建sessions。

命名空间六项关键配额持久化为校验保护的配置，重复初始化必须一致。会话数量直接从命名空间 sessions 目录中的已发布日志计数，不设置第二套计数事实。创建和分支在全库锁内检查配额，以同一文件系统的原子 rename 发布完成文件；跨进程读也取得同一锁，因此目标完整可见与配额观察一致。

每个会话使用一个只追加 JSONL 日志：首行是带校验的创建头，正文行记录 seq/time/json/bytes，批次最后一行是提交描述、投影增删、回执及 SHA-256 链校验。投影仅保存 position/seq，差异按集合计算，事件批次不重复写整份投影；允许旧节点任意重复加入及位置变化。日志超过max(1MiB,2×当前规范快照编码长度)时，在提交同步后将全部不可变记录、全部回执和完整投影写为带结束校验的快照，经pending同步原子替换旧日志；不同时构建第二份记录索引，发布后缓存失效。快照保留原创建身份和父信息；fork仍不继承回执。快照首行mode=snapshot声明预期revision/bytes/回执数量，缺少完整基线结束标记属于损坏；基线结束标记声明并核对revision、bytes、record数、receipt数，摘要覆盖原头、全部记录、回执和nodes。回执commitId唯一、fingerprint规范，按seq连续无交叠，覆盖父前缀之后至当前revision。

每个 footer 的摘要覆盖上一已提交摘要、本批全部原始正文行和 footer 的规范描述。重放验证规范编码、UTF-8、连续序列、原始正文字节、配额、节点引用/位置、提交身份以及摘要链。完整但无效的行或 footer 返回 storage-corrupt，即使它是最后一行也不静默删除。

分支把不可变源前缀逐条复制到唯一 pending 文件，保留原正文行及时间，写入完整分支投影与结束标记后 sync，再 rename 为目标日志；不复制父回执。分支头标明预期前缀，已发布分支缺少有效初始结束标记属于损坏。重复分支先读取目标创建身份，不重新读取源。

## 锁、原子性与恢复

Bun FFI 调用本机 libc flock(LOCK_EX|LOCK_NB)，独立打开的描述符彼此竞争；锁由操作系统在描述符关闭/进程死亡后释放。全库一把锁协调本机所有进程，进程内有界串行队列。锁等待只轮询非阻塞系统调用，5ms退避，最多一个在途轮询计时器；超时 busy，取消 cancelled。锁文件绝不删除/替换。FFI库及描述符属于插件资源，队列及实际I/O排空后关闭。

取得锁后清除上一次死亡进程留下的唯一 pending 文件；不存在活跃写者可被误清理。所有读写及恢复都在锁内。新增目录、文件的持久化包括文件 sync 和相关父目录 sync。成功回执仅在完整 footer 与同步成功后返回；无法同步明确报存储不可用。取得锁后加载/恢复日志时也同步观察到的完整状态，避免上一个未知结果留下的未同步 footer 被当作持久化确认。每次成功操作（包含create/fork/commit的幂等路径）均同步访问的日志及其sessions、namespace、namespaces、root及所有祖先目录（直到文件系统根，覆盖递归创建的父目录），完成未知rename的目录持久化。

正常追加先验证身份、CAS和全部预算，再写正文及 footer；写 footer 前检查取消。footer开始后完成同步，不宣称取消能撤销已提交数据。若I/O失败，缓存失效，下次锁内恢复判定最终结果。相同commitId重试先读回执，再做版本检查；阴性查证不证明其他在途调用不会提交。

物理EOF处不含换行的片段，或合法正文行但缺少 footer，是未提交尾部；恢复截断到最近完整提交边界并 sync。完整无效行/校验失败不会按尾部垃圾吞掉。创建与分支的 pending 文件仅在完成后发布，死亡时留下的 pending 不计入会话数量。已发布文件如缺少有效创建或分支基线，明确报损坏。

## 索引、预算与性能

内存只保留记录的偏移/长度/时间/字节/摘要、提交回执和投影索引，不缓存历史正文。每实例只缓存最近一个会话的索引，记录索引总数最多为领域 maxRecords 硬上限400000，回执与投影节点总数受记录数限制。切换会话先清空原缓存；单次操作的重放临时空间为常数倍一条编码行和一批最多512条记录索引。文件变更按inode/size/mtime识别，正常增长从最近提交边界增量重放，读取正文时验证其行摘要。相同大小但修改时间改变、inode替换或缩短时丢弃缓存并完整校验。非协作方直接改写文件不属于并发协议。

默认每页4MiB/最多1000条，硬上限16MiB/4000条，沿现有契约保留信封余量。每条编码行上限 max(4MiB,6*maxRecordBytes+1024)，读缓冲64KiB；JSON字符串转义可能扩大正文，预算同时考虑编码行。日志物理大小上界由 6*maxSessionBytes+256*maxRecords*(maxConversationNodes+4)+1MiB 推导，超额明确拒绝；上界逐项预算：正文最多6倍UTF8字节，record信封每条小于128字节，单个node/移除项小于64字节，单次footer固定身份字段小于512字节，头及metadata不超过1MiB；每批至少一条记录、每次差异至多两份nodes，采用256*(nodes+4)逐记录覆盖。该保守上界允许每次合法提交重复加入全部旧投影节点；正常运行在提交后整理使文件低于整理阈值加一个最大批次。进入提交操作时若现有日志超阈值必须先成功整理才允许追加；只读操作不因整理失败而失去读取完整提交的能力；整理复制后用原记录长度原地重算偏移，不分配第二份记录索引。快照基线记录直接进入待验证的主索引，失败整份丢弃。进程死亡可能留下已提交但尚未整理的日志，下一次加载保留完整事实并在写入后整理，不以更小假上界拒绝合法事实。该上界是协议防护，不代表精确堆占用或文件系统配额。恢复、复制及文件I/O在每个异步步骤间检查整体operationTimeoutMs和调用signal；系统I/O仍由core保留actual直到收敛。

原有SQL库的纯存储请求验证、六项policy验证和有界队列移到 session/storage 公共作者工具，以唯一实现复用；消息领域与SQL代码不迁入JSONL。相关原测试迁至所属模块，不减断言。另一程序Agent正在写session的TDD测试，其文件和实现修复不覆盖；共享文件合入前逐项对比当前内容。

## 依据

锁语义依据 [flock(2)](https://www.man7.org/linux/man-pages/man2/flock.2.html)，FFI依据 [Bun官方文档](https://bun.sh/docs/runtime/ffi)。本机两独立描述符实际竞争及释放探针已通过；Linux实现需要对应部署环境验证，不把macOS结果宣称为Linux实测。
