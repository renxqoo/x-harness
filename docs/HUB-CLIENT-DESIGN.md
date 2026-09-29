# HUB-CLIENT SDK 设计基线（host-hub 进程客户端 SDK：企业级）

> 状态：**审查闭环，待用户定稿**（三轮七视角对抗审查全量清零：第一轮 并发/测试/消费端/契约对拍，第二轮 可维护性/内部一致性/host-hub 维护者，第三轮 定稿收口）
> 级别：**大**（跨应用、新子系统、契约重组；无不可逆存量数据变更）
> 方法论：feature-dev-v2（借件：借存量审计纪律与装置适配记录，收口按本工作流清单；大级三件套结构按 repo-migration-e2e 文档族拆分）
> 上游裁决：2026-09-29 对话（命令面盘点 → SDK 形态 → 多用户组网）。

---

## 0. 定位

把 host-hub 的 JSONL 进程命令协议变成**任何服务可嵌入的客户端 SDK**：
`hub.call("thread/list")` 直接返回 response 帧 parse 后的原样 JSON；
帧契约（词表/错误码/key 序/分帧）从 host-hub 抽出为独立契约包
`@x-harness/hub-protocol`，host-hub、hub-client、hub-gateway 三方共同消费，
消灭一切镜像副本。

本文档是**文档族入口**：只持定位、导航、总裁决速览与审查记录，**不持有任何
实现细节/参数硬值——细节单源住在分册**（同一事实只在一处定义，他处引用）。

## 1. 文档族导航

| 分册 | 内容 | 读者 |
|---|---|---|
| [01-context.md](hub-client/01-context.md) | 背景、协议面存量事实（file:line 锚定）、目标/非目标、裁决记录全量（U/D）、术语表 | 所有人（先读） |
| [02-architecture.md](hub-client/02-architecture.md) | 分层与依赖不变量、设计原则、分包先例对齐、并发/一致性预算（B 系）、传输扩展点 | 架构评审 |
| [03-hub-protocol.md](hub-client/03-hub-protocol.md) | 契约包：逐文件移动清单、增补类型、封闭性门禁（C 系）、契约演进流程 | 实施者 |
| [04-hub-client-sdk.md](hub-client/04-hub-client-sdk.md) | SDK 本体：文件架构、connectHub/call/事件时序（exit 三步/close/kill/死线）、受理-完成二段性、transport 抽象、与 gateway 差异表 | 实施者/消费端 |
| [05-observability.md](hub-client/05-observability.md) | 观测面：stats 字段口径、log/onRawLine 缝、心跳透传、消费端接入模式、CommandResponses 类型面 | 消费端 |
| [06-pool-multiuser.md](hub-client/06-pool-multiuser.md) | createHubPool（TTL/evicting/closeAll/dispose）、多用户多 session 组网、隔离矩阵、越权矩阵、重启恢复 | 服务端消费端 |
| [07-testing.md](hub-client/07-testing.md) | 测试口径：单元/契约/封闭性三层、装置迁移（src/testing 子出口）、覆盖率与门禁、环境裁剪纪律 | 实施者/审查 |
| [08-implementation.md](hub-client/08-implementation.md) | 实施顺序五阶段、过渡态规则、风险清单（R 系）、在途变更协调、验收清单 | 实施者 |

## 2. 总裁决速览（理由与否决窗口见 01 §5-6）

| # | 裁决 | 一句话 |
|---|---|---|
| U1 | SDK = host-hub **子进程客户端**（spawn + JSONL），不是把 host 实现搬进库 | 用户裁决 |
| U2 | `call()` 直接返回 response 帧 parse 后的原样 JSON，**永不 reject**（connectHub 的 reject 是唯一例外） | 用户裁决 |
| U3 | 用户 → host 进程（隔离单元），session → thread（并发单元）；跨租户每用户一根 host | 用户裁决 |
| D1 | 包位置 `packages/hub-protocol` + `packages/hub-client` | 默认裁决 |
| D2 | 业务失败 = `success:false` 分支；传输失败 = 合成同构 response（code=protocol），错误码表不扩项 | 默认裁决 |
| D3 | 不自动重启：`exited` + `exit` 事件 + `close()/kill()`，策略归消费端 | 默认裁决 |
| D4 | 呼叫超时逐呼叫可覆盖（从进入 call 起算含背压排队）；晚到响应丢弃+计数（缺省分层单源：04 §2/05 §5） | 默认裁决 |
| D5 | 只做通用 `call(command, args?)` + 类型映射表，不手写全量命令方法糖 | 默认裁决 |
| D6 | gateway host-attach 整体迁移不在本期；只消灭 fanout 帧分类镜像 | 默认裁决 |
| D7 | `createHubPool` 池化组件进包（纯逻辑、工厂注入、无重启策略） | 默认裁决 |
| D8 | 观测面 = `stats()` 拉模型 + `log` 缝 + `onRawLine` 缝 + 心跳透传，不绑 metrics 实现 | 默认裁决 |
| D9 | response data 类型增量标注，未标注命令落 `unknown` | 默认裁决 |
| D10 | 不内置命令重试（幂等性是命令属性） | 默认裁决 |
| D11 | 池空闲回收策略注入（`idleTtlMs`；槽活跃度含 call 时刻），无引用计数（缺省值单源 06 §1） | 默认裁决 |
| D12 | call 不暴露自定义 id（id 仅 SDK 铸造永不复用）；bindHub 计活替代 onSettled 缝 | 第二轮裁决 |

## 3. 事实基线口径

命令词表/错误码数量等**不硬编码在本文档**——单源在 hub-protocol（迁移后），
现状锚点与 file:line 见 [01 §2](hub-client/01-context.md)；缺省参数硬值分层单源：
连接级（超时/死线/宽限/队列上界）在 [04 §2](hub-client/04-hub-client-sdk.md)、
命令族超时在 [05 §5](hub-client/05-observability.md) CommandTimeouts、跨 app
收编预算在 [03 §1](hub-client/03-hub-protocol.md) CEILING（C8 门禁钉住）；
并发预算（B 系）单源在 [02 §6](hub-client/02-architecture.md)。

## 4. 审查记录

> 状态机：草稿 →（多轮对抗审查清零）→ 定稿 → 实施 → 已核销。
> 每轮：多视角并行审查 → 逐条处置（接受/驳回+理由）→ 原审查方复核清零 →
> 下一轮换全新视角。处置明细在各分册就地修订，本节记轮次结论
> （先例：SESSION-WORKTREE-WORKFLOW §10）。**本节是不可变史志**：表中数字/结论
> 为当轮快照，不随分册演进同步更新——活事实一律以分册为准（防入口长成第二事实源）。

| 轮次 | 视角 | 发现 | 处置 | 复核 |
|---|---|---|---|---|
| 第一轮 | 并发/竞态/资源生命周期 | 20 条 + 横切 C1（8H/10M/2L + H） | 全部接受，分册修订（exit 锚 stdout 'close'、死线三层防护、背压先登记后写+drain 竞争+stdin error、kill 宽限 45s、id 已用集合、池活跃度+evicting、closeAll 终态+dispose、B1'/B3'/timer 缝） | **全量清零**：20+2 全通过（#4 再修后通过、C1 入口重写后通过）；3 条非阻塞记录项已落档（#4 理由句、flowing/paused 实施形态、D4/D11 数字口径） |
| 第一轮 | 契约对拍 | 29 条 + 复核 5+3（5H/13M/11L） | 全部接受：thread/start 响应语义修正（host 成功不回 response，worker 异步回且 data 含 threadId）、get_models 实为 modelShapeOf 输出（catalog-types 不迁裁决）、images.ts 仅类型随迁、bash 改即答族（无 settled）、**jsonl discard 实测反转**（3000 fuzz 证不吞好行，推翻并发轮误报）、OBSERVER 留 host-hub（C1 断言随留）、confirmTimeout 向量改归属、域计数/锚点/引用批量修正 | **全量清零**：初查 29 → 复核 5 未过+3 注 → 终判 8/8 通过；discard 裁决由审查方独立复测确认 |
| 第一轮 | 消费端/组网/安全 | 29 条 + 复核 N1-N8（6H/15M/8L + 事实反转 N1） | 全部接受：超时映射清单（网关错配/必放宽命令族）、opts.signal 取消面、settled 生命周期=连接生命周期、TTL turn 活性错位披露（保活/预算权衡）、host 无自退+千用户算术、key 消毒 P1、OS 层隔离 P2（BYO key 仅同信任域）、管理面越权整节（命令白名单）、ui_response noop 谎报、fence 三洞挂账 R8、abort settled 按代码事实改写（ok:true 歧义披露）、env 五禁键拦截+合并序、id 环形上界、call_completed/call_failed 词表、凭据帧内置打码、基数警告、凭据生命周期、入口去硬值 | **全量清零**：29+5+8 全通过（N1 abort 方向反转已按代码修正；入口零硬值自洽 grep 实证）；1 条记录项落档（TOCTOU 注入向量） |
| 第一轮 | 测试口径/实施可行性 | 14 条 + 复核补 2（3H/8M/3L + 2L） | 全部接受：装置迁移前移阶段三、装置分母口径实测纠正（计入，不达标则显式 exclude）、ScriptStep 本地声明闭包、timer 缝 timeout/interval 分物种+unref、pool timer 缝、17MiB spawn 缝直写路径、用例数核销、探测装置化+真向量强制、超时纪律、契约六域拆分、B7 同文件重写挂阶段三、符号级验收、R7 三日升级 | **全量清零**：15 条全通过（含 3 处跨分册同步再修 + 2 条 L 注已落档：acquire ctx.onSettled 签名、分块不变性住 hub-protocol C5） |
| 第二轮 | 可维护性与演进 | 19 条 + 三轮复核（3H/10M/6L） | 全部接受：词表升类型（CommandName 联合，编译期拼写防护）、单源机械门禁（入口零硬值 grep+链接+裸引用检查进 scripts）、跨包推导钉子（HOST_SHUTDOWN_BUDGET_CEILING 契约常量+C8 双端门禁）、登记处扩五面、C7 键⊆词表门禁、测试缝撤出公共面（createTestHub 子出口）、bindHub 计活统一、opts.id 删除（含环形 apparatus 全清）、CommandTimeouts 单源+优先级裁决、InputOf 投影源、closeAll 语义归一、off 三参、时序注入纪律+flake 预案、传输承诺精确边界、framesByKind/三新计数字段、文档族收口+概念退役检索法沉淀 | **全量销项**（四轮：初审 19 → 复核 7 补 → 复核 2 补+自捕 1 → 终验全过独立复跑） |
| 第二轮 | 内部一致性红队 | 16 条 + 复核追加 N1-N5/R1（2H/6M/8L） | 全部接受：pool 测试缝撤公共面同策（createTestPool）、入口分层单源（连接级/命令族/跨 app 三层）、02 §8 双计数器口径、四族主句、C1-C8 枚举同步、README 验收同集、活数替代死数、D12 落档、死线权威单向、testing 通路回写、command-types 运行时定性、unknown_command 宽入口；编号重排广播（3+4→完整解析序） | **全量销项**（初审 16 → 4 未落地 → 2 半落地+R1 → 终清全族归零扫描） |
| 第二轮 | host-hub 维护者 | 13 条 + 复核追加（结构损坏 H/entry 口径 M）（2H/4M/7L + H/M） | 全部接受：C4 全字面量锚+九用例映射核销+双标拉平、测试面手写镜像进阶段五验收（responseLine×4）、OBSERVER 断言承接指定、ScriptStep 裁决记录+同步项登记、host-private 逃生门、词表↔处理器双向断言+注册表键导出前提、resolve-host 第 4 候选（四级路径/五步序/完整解析序恒 src）、两个翻转点、package.json 依赖提交面、dist 形态披露、分帧表述改准、isKnownCommand 删除、docs 锚点修缮+性能契约随迁、**03 结构损坏修复（脚本拼接事故）+重复节标题门禁** | **全量销项**（初审 13 → 3 未落地 → #7/nit-d → 结构 H → entry M → 终清；debris 复扫净） |

## 5. 验收清单（收口核销，逐项指针到分册）

- [ ] U1/U2/U3 契约逐条：[04](hub-client/04-hub-client-sdk.md)、[06](hub-client/06-pool-multiuser.md)
- [ ] 契约抽包完成、host-hub 与 gateway 零残留副本：[03 §2](hub-client/03-hub-protocol.md)、[08 §2](hub-client/08-implementation.md)
- [ ] API 与语义逐条（id 守卫、行超限本地拒、exit 三步锚 stdout 'close'、close/kill、二段性）：[04](hub-client/04-hub-client-sdk.md)
- [ ] 观测面全量 + 消费端零改接入：[05](hub-client/05-observability.md)
- [ ] pool 语义逐条 + 多用户组网可组装 + 越权矩阵：[06](hub-client/06-pool-multiuser.md)
- [ ] 测试口径三层全绿 + 回归用例带症状命名：[07](hub-client/07-testing.md)
- [ ] 并发/一致性预算逐条（B 系含 B1'/B3'）：[02 §6](hub-client/02-architecture.md)
- [ ] 四门全绿 + 覆盖率数字如实报告（阈值 90/85 不动）：[07 §6-7](hub-client/07-testing.md)
- [ ] 对抗审查问题清零（本节轮次表）
- [ ] host-hub 装置迁移后其全量测试绿；gateway 测试绿：[07 §5-6](hub-client/07-testing.md)
- [ ] 包 README：验收项与 08 §5 同集（含退出前 close 纪律/复杂度对照表/must 清单——全量清单以 08 §5 为准）
- [ ] 文档族收口 + 机械单源门禁（08 §5 末两项：归档退役 + 零硬值/链接/裸引用/重复节检查进 scripts）
