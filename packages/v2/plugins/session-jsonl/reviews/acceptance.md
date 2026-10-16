# JSONL 交付验收

状态：已核销。2026-10-17。原路径 packages/v2 完整验证。

## 交付

独立 session-jsonl 插件实现八项 SessionStorage 操作，session负责对话投影，core保持业务无关。默认SQLite。请求/policy校验和有界队列迁入session/storage公共作者工具，SQL旧路径删除，原断言迁至所属模块。新插件没有SQL依赖、历史导入或兼容路径。

全库OS锁协调本机进程；追加记录以校验结束行提交。恢复保留完整批次，截断未完成尾部，完整损坏拒绝。分支经同步后的临时文件原子发布；整理保留所有回执，强制完整快照基线。记录正文按偏移读取，只保留最近会话索引。单实例串行且队列有界，关闭排空实际工作并关闭描述符及FFI库。

## 核销

| 项目 | 证据 |
| --- | --- |
| 公共契约、幂等、CAS、分页、分支与namespace隔离 | contract.test.ts 内两个独立客户端，公共20项检查 |
| session投影、替换、事件及前缀分支 | session-journey.test.ts |
| 连续记录及footer任意字节断尾、完整坏行、摘要和UTF8 | recovery.test.ts / corrupt-values.test.ts |
| 反复重加旧节点、改变位置、快照回执完整、整理失败后不积累新批次 | compaction.test.ts |
| 短写、零写、文件/目录同步失败、rename失败、取消提交点、实际关闭及重试 | io-failures.test.ts |
| 真实进程CAS、同ID提交、SIGKILL释放锁、半footer及成功回执重开 | process-journeys.test.ts |
| lock/format/policy bootstrap死亡、fork发布前后死亡 | process-journeys.test.ts |
| 原始及构建入口共享token并正常退出 | 两个真实子进程旅程 |
| 目录归属、链接、文件种类、垃圾配置、配额、偏移/编码行预算及缓存失效 | boundaries.test.ts / file-primitives.test.ts / recovery.test.ts |
| SQLite/PG同seq移动position一致性 | projection-position.test.ts，两后端独立读取；保留批量删除回归 |

另一程序Agent的TDD及实现修复按原内容合入验证。其未使用变量由对方清理，所有断言保留。共享SQL头metadata预算修复与批量删除保持，另修复经过双后端红测确认的位置移动遗漏。

## 独立审查

方案审查发现投影反复加入使旧物理上界推导失效、bootstrap崩溃无法重开。现支持差异追加与快照整理，并恢复保留名初始化状态。快照头标识强制基线，校验记录/字节/回执数量及连续区间；超阈值必须先整理才允许再追加。

首切片审查微复现了拒绝陌生目录前删除pending、新建祖先目录未同步、pending同步后取消仍发布三项，均修复并加入行为回归。终审未发现新增确定缺陷。独立运行探针106条断言检查未知同步结果幂等、4136 revision、49份回执和两实例完整分页，源码及输出保存在本目录。

8项隔离负控制全部被行为断言检出：CAS、指纹、footer摘要、同步、分支前缀、断尾截断、强制快照基线、发布前取消。突变只写临时副本；正常源码未应用突变。不新增skip、不删断言、不降低阈值，不以导入/编译失败冒充检测。

## 四门与覆盖率

原路径lint、typecheck、build、test全部成功。Lint 0错误0警告；118个类型负例和31个文档示例通过预期检查。全工作区99文件728用例；其中JSONL为9文件53用例，公共20项是检查断言，不另加进用例数。

| 指标 | 覆盖率 | 覆盖/总量 | 阈值 |
| --- | --- | --- | --- |
| Statements | 93.26% | 4969/5328 | 90% |
| Branches | 91.27% | 3463/3794 | 88% |
| Functions | 97.89% | 884/903 | 95% |
| Lines | 98.29% | 3122/3176 | 96% |

机器结果及源码哈希见verification-results.json。环境macOS26.5.2 arm64、Bun1.4.3，数据库旅程使用隔离SQLite和真实PostgreSQL。全量测试含现有平台与数据库回归，未运行e2e/main.ts。

## 部署边界

本机macOS实测。Linux/glibc实现需要目标环境同套验证；没有硬件断电实测，不把SIGKILL等同断电。耐久性依赖文件系统兑现sync与同文件系统rename。该后端不承担共享网络文件系统、多机复制和选主；多节点部署使用PostgreSQL。整理需要临时磁盘空间，备份须关闭实例或持有同一锁。
