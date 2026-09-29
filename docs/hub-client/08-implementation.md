# 08 · 实施顺序与验收

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；各分册定稿后本册是施工合同。

## 1. 阶段划分（每阶段独立提交、四门全绿；de-risk 切片 = 阶段一）

### 阶段一：契约抽包（de-risk）

建 `packages/hub-protocol`：03 §2 移动清单 2.1-2.7 + 2.9（2.8 不迁；移动即删，host-hub 导入翻转）
+ §3/§4 增补 + §5 封闭性测试迁入 + **host-hub 改动**：host-commands 注册表键
导出（「handlers ⊆ 词表」断言的测试缝）+ 词表↔处理器双向一致性断言随迁
（audit-fixes 矩阵扩容——03 §6）；gateway fanout 换 classifyHostLine 导入
（删镜像）；依赖面：host-hub 与 hub-gateway 的 package.json 各加
`@x-harness/hub-protocol: workspace:*` + bun.lock 更新（同提交）。

**验收**：四门绿 + 封闭性断言在新包内绿 + host-hub/gateway 全量测试绿 +
`grep -rn "classifyHostLine" apps/` 只剩 import 行（符号级残留清单见下方补充）。

### 阶段一验收补充（可机械执行）

- 残留判定按**符号**不按文件：internal.ts/limits.ts 拆分后仍存在（内容缩减），
  验收脚本核「迁出符号不在 apps/ 重复定义」而非「文件消失」；符号清单 = 03 §2
  表右列全集；
- classifyHostLine 迁移附**用例数核销**：gateway units.test.ts 迁入 hub-protocol
  的用例数 = 删除数（07 §4 逐用例对照清单）。

**为什么它是 de-risk**：纯搬家 + 导入翻转，零行为变更，独立可验证可回滚；验证
「移动清单是否完整、封闭性测试能否在新家钉住、gateway 换导入是否逐字节等价」
——流程本身被验证，后续阶段按校准过的流程放量。

### 阶段二：hub-client core 纯逻辑

ids/events/stats/core + command-types 骨架 + transport 接口；假传输全单测（07 §2）。

**验收**：core 系覆盖率 ≥ 阈值；四门绿。

### 阶段三：process 传输 + connectHub + **装置先行迁移**

**装置迁移前移至本阶段首步**（阶段五的原装置部分拆入）：host-hub
`__test__/kit/host-client.ts` 迁 hub-client `src/testing/`（经
`@x-harness/hub-client/testing` 子出口导出），同提交删除 host-hub 旧件、其全部
消费测试改 import 子出口（dogfood 单轨）——否则 hub-client 契约测试只能跨包引
别的包 `__test__` 私有件或在包内复制装置，两者都违规。

然后：process/resolve-host/connect（含 heartbeat-supervisor）+ **hub-protocol
jsonl.ts 链式缓冲重写**（02 §6 B7：同文件重写内部缓冲、公共接口不变、行为保持
——07 §3 分块不变性对拍钉等价）+ 真 host 契约测试（07 §3，装置用刚迁的
src/testing）。

**验收**：07 §3 全绿（含死线/孤儿/close-kill 矩阵）+ host-hub 全量测试绿
（装置迁移回归）+ 覆盖率含 src/testing 后仍达标（见 §2 装置分母口径）。

### 阶段四：pool + 观测面收口

pool.ts + stats 聚合 + log/onRawLine 缝 + 包 README（对外行为、消费端接入、观测接入
模式、04 §5 二段性披露、06 组网参考、onRawLine 生产警告、**复杂度对照表**：
≥12 个概念逐一标注「host 协议本质 vs SDK 取舍引入」+ 取舍项替代方案——新消费端
学习曲线单点收敛于此）。

**验收**：07 §2 pool 用例绿 + README 审读（无版本叙事、只描述当前行为）。

### 阶段五：存量收口

镜像清零核查（`grep -rn "classifyHostLine\|createJsonlSplitter\|responseLine" apps/`
只剩 import——**含测试面手写镜像**：host-gaps/host-pool/host-pool-query 的本地
`responseLine` 函数与 audit-fixes 的 `responseLineOf` 是真格式镜像，迁 hub-protocol
import 或改用构建器，同批清零）；host-hub 全量测试绿；**修缮收尾**：apps/host-hub/docs 三份文档对 protocol/、
shared/ 的 file:line 锚点随迁移失效——同批修缮或头部标注「以代码为准」；
**性能契约迁移**：classifyResponseHead 的零 parse 热路径契约
（audit-fixes.test.ts:213-220 的 2000 帧 <1ms 断言）随分类器迁 hub-protocol——
跨包性能钉子必须同包持有（B7 重写波及时有门禁）。覆盖率与验收清单核销。
（装置迁移已在阶段三完成。）

## 2. 过渡态规则（过渡允许，收口必须单轨）

- 阶段一后：host-hub 内**零残留副本**（移动即删，无过渡双轨——依赖翻转在同一
  提交完成）；
- 阶段三前：hub-client 内零测试专用 host 装置副本——装置单点住 hub-client
  `src/testing/`（经 `@x-harness/hub-client/testing` 子出口导出），迁移在阶段三
  首步完成。工程铁律「禁止跨包引用别的包 __test__ 私有文件」的解法：装置文件住
  `src/testing/` 非 `__test__/`——装置即产品（dogfood 语义）；
- **装置分母口径（实测纠正）**：`src/testing/` 命中 vitest coverage include
  通配、不命中任何 exclude——**计入覆盖率分母**。处置：装置代码按产品标准测试
  （其异常分支由契约测试 + dogfood 回归盖）；**裁决（现在定，不留实施中途的退路）**：
  src/testing 计入分母且**不走 exclude 逃生门**——装置是导出面就按产品标准测试，
  覆盖率不足只补测试（与「未达标只许补测试」门禁精神一致；装置的 spawn 等待器/
  谓词逻辑本就全路径可测）；
- **装置依赖闭包**：ScriptStep 本地副本是**有意的类型镜像**（裁决记录：不迁
  script-adapter——host 运行时消费件；代价 = host-hub 新增剧本变体时跨包同步，
  该同步项已登记进 03 §6 演进流程「ScriptStep 同步项」条目——漏同步时 host-hub 测试类型红
  即警报）；kit 默认 entry 是相对路径 `join(import.meta.dirname, "../../host/cli.ts")`——迁移后改走 resolve-host 完整解析序（候选 2 与 4 双路径恒定 src 入口——04 §7），不硬编码相对路径；
- 全程：不写兼容别名、不留双轨字段（CLAUDE.md 零兼容层铁律）。

## 3. 在途变更协调（本方案落地时的并行纪律）

成文时工作区曾有 thread/notify 族在途变更（现已提交 `9e0dddb`，词表 80、`git status` 仅 docs 项）。协调规则保留（防未来在途冲突）：

- 阶段一触碰 commands.ts/internal.ts/frames.ts/errors.ts/jsonl.ts/limits.ts——与
  thread/notify 在途改动**同文件**；
- 执行纪律：待在途改动提交后再动阶段一（避免共享产物混提交）；若并行实施，
  用 git worktree 物理隔离（CLAUDE.md 并行开发铁律）；
- thread/notify 使词表 79→80：本方案不硬编码词表数字（03 §5-C2 单源锚点），
  在途合入不与本方案冲突——这是「数字不进文档、封闭性测试单点锚定」设计的
  直接收益。

## 4. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | jsonl splitter 的 discard 语义（**实测修正**：超限只丢行自身残余段，**不吞后续好行**——3000 次随机切块 fuzz 零丢失，jsonl.ts:25-56） | 契约测试钉现行为两形态：分裂超限（residualOversize→discarding，下 chunk 好行正常产出）与整行超限（oversize 计数、后续行不受影响）；此前「连吞好行」描述与实测相反，已修正；行为冻结不在本期 |
| R2 | flush() 不查上限不剥 \r（jsonl.ts:58-66） | 同 R1：钉现行为不静默改 |
| R3 | host 停机不补在飞响应（除 worker 收编路径）——close() 期间晚到呼叫可能只拿到合成 failure | 04 §4-3 已披露；契约测试：close 前 call 的结算路径（host shutting down 响应或合成，二断一）；**exit 锚 stdout 'close' 保末帧冲刷不丢**（07 §3 末帧不丢向量） |
| R4 | spawn -STOP / pgrep 平台差异（CI 可用性） | 07 §7 环境裁剪纪律：运行时能力探测装置化（可审查），macOS/Linux 与常规 CI 必走真向量，仅无信号环境降级替身——不是 skip 换绿 |
| R5 | oxlint max-lines 500（skipComments）——process.ts/connect.ts/契约测试可能超 | 04 §1 拆 heartbeat-supervisor；07 §1 契约测试 contract-* 按域拆分；不加 lint-disable |
| R6 | host-hub 测试改 import SDK 后，测试图成环（host-hub devDep hub-client + hub-client 契约测试 spawn host-hub） | 方向核验：hub-client 的 dependencies 只有 hub-protocol；host-hub **devDependencies** 引 hub-client 仅测试用；契约测试 spawn 的是文件路径不是包名，无运行时环 |
| R7 | 在途变更同文件冲突（协调规则泛化保留；实测 host-hub 内约 44-52 文件 import 待迁模块——阶段一启动时重测取精确值） | §3 协调规则；**等待时限**：在途变更超过 3 个工作日未提交则升级用户仲裁（继续等 / worktree 隔离强行分流），不无限期阻塞 |
| R8 | host 侧安全/语义缺口（不属本方案改动面，挂账防丢失）：fenceSessionPath 的 realpath 失败跳检 + stat-TOCTOU + 非规范形注册三洞（06 §5.4）；settled.ok 无法区分 aborted/max-tokens（06 §3 abort 语义）；jsonl discard 边缘语义（R1 实测已正名：不吞好行） | 契约测试钉现状行为（07 §3 含 fence 三向量、abort settled 向量）；修复归 host-hub 专项（跨 app 改动，本方案不越权代修） |

## 5. 验收清单（逐项核销，全勾才算完成）

- [ ] U1/U2/U3 契约逐条：call 返回 response JSON 原样（永不 reject，connectHub reject
  唯一例外）；多用户组网按 06 可组装
- [ ] 03 §2 移动完成、host-hub 与 gateway 零残留副本（grep 核查）；hub-protocol 零
  @x-harness 依赖
- [ ] **02 §1 不变量逐条**：I1 hub-protocol 零 @x-harness 依赖、I2 host-hub
  无 hub-client runtime 依赖（package.json dependencies 断言，devDep 测试装置
  除外——阶段三核）、I3 core 零 node:child_process import（04 §1 依赖纪律）、
  I4 check-kernel-deps 不变量（hub-protocol 不进内核组）
- [ ] 04 §1-§4 API 与语义逐条（依赖纪律 + id 守卫、行超限本地拒、exit 三步、close/kill、
  二段性披露）
- [ ] 05 观测面全量字段 + log/onRawLine 缝 + 心跳透传；消费端可零改接入
- [ ] 06 pool 语义逐条（去重/清槽/TTL/evict/聚合）+ 越权矩阵
- [ ] 07 测试口径全绿（单元/契约/封闭性三层）；回归用例带症状命名
- [ ] 02 §6 预算逐条：定时器 ≤2 常驻、行缓冲 16MiB、事件零缓存、pending 稳态归零断言
- [ ] 四门全绿 + 覆盖率数字如实报告（新包计入分母，阈值 90/85 不动）
- [ ] 对抗审查（契约/并发密集批次逐批 + 文档定稿轮）问题清零（入口 §4 轮次表）
- [ ] host-hub 装置迁移后其全量测试绿；gateway 测试绿
- [ ] 包 README：对外行为、二段性、观测接入、组网参考、onRawLine 生产警告、
  退出前 close/closeAll 纪律、版本对齐由部署保证、**复杂度对照表（≥12 概念：host 协议本质 vs SDK 取舍 +
  替代方案）+ must 清单必读栏（sendId 清表/bindHub/弱信号）**——无版本叙事
- [ ] **文档族收口**：README + 测试成为活契约后，本方案族头部标注「已实施，
  活契约见 README/测试」并归档；file:line 锚点随之退役（防「看起来仍权威」
  的腐烂源）
- [ ] **机械单源门禁**：入口「零硬值」grep 检查 + 全族 md 链接有效性检查 +
  **裸 § 引用解析校验**（`0X §Y` 模式 → 目标节存在性，动态计数）+
  **重复节标题检查** + **围栏奇偶配对**（code fence 计数奇数即红——收口轮实测撞上的孤栏类）进
  scripts（与 check:kernel-deps 同列的 docs 检查——单源纪律从人肉升级为门禁；
  处置核销一律以文档 grep 实证为准，不以处置摘要为准；**概念退役检索法**：软换行
  文档先去换行（tr -d 后检索），名词型退役用短锚词、指令型退役用最短词干）
