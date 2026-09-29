# 08 · 实施顺序与验收

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；各分册定稿后本册是施工合同。

## 1. 阶段划分（每阶段独立提交、四门全绿；de-risk 切片 = 阶段一）

### 阶段一：契约抽包（de-risk）

建 `packages/hub-protocol`：03 §2 移动清单 2.1-2.8（移动即删，host-hub 导入翻转）
+ §3/§4 增补 + §5 封闭性测试迁入；gateway fanout 换 classifyHostLine 导入（删镜像）。

**验收**：四门绿 + 封闭性断言在新包内绿 + host-hub/gateway 全量测试绿 +
`grep -rn "classifyHostLine" apps/` 只剩 import 行 + host-hub `shared/` 与 `protocol/`
无残留原件（03 §2 清单逐项核销）。

**为什么它是 de-risk**：纯搬家 + 导入翻转，零行为变更，独立可验证可回滚；验证
「移动清单是否完整、封闭性测试能否在新家钉住、gateway 换导入是否逐字节等价」
——流程本身被验证，后续阶段按校准过的流程放量。

### 阶段二：hub-client core 纯逻辑

ids/events/stats/core + command-types 骨架 + transport 接口；假传输全单测（07 §2）。

**验收**：core 系覆盖率 ≥ 阈值；四门绿。

### 阶段三：process 传输 + connectHub

process/resolve-host/connect + 真 host 契约测试（07 §3）。

**验收**：07 §3 全绿（含死线/孤儿/close-kill 矩阵）。

### 阶段四：pool + 观测面收口

pool.ts + stats 聚合 + log/onRawLine 缝 + 包 README（对外行为、消费端接入、观测接入
模式、04 §5 二段性披露、06 组网参考、onRawLine 生产警告）。

**验收**：07 §2 pool 用例绿 + README 审读（无版本叙事、只描述当前行为）。

### 阶段五：存量收口

host-hub `__test__/kit/host-client.ts` 迁 hub-client `src/testing/`（经
`@x-harness/hub-client/testing` 子出口导出；旧件删除，host-hub 测试改用
 SDK——dogfood；单轨）；镜像清零核查（`grep -rn
"classifyHostLine\|createJsonlSplitter\|responseLine" apps/` 只剩 import）；
host-hub 全量测试绿；覆盖率与验收清单核销。

## 2. 过渡态规则（过渡允许，收口必须单轨）

- 阶段一后：host-hub 内**零残留副本**（移动即删，无过渡双轨——依赖翻转在同一
  提交完成）；
- 阶段五前：hub-client 内零测试专用 host 装置副本——装置单点住 hub-client
  `src/testing/`（经 `@x-harness/hub-client/testing` 子出口导出）。工程铁律
  「禁止跨包引用别的包 __test__ 私有文件」的解法：装置文件住 `src/testing/`
  非 `__test__/`——装置即产品（dogfood 语义），不进覆盖率分母、不属 __test__
  私有件；阶段五完成后 host-hub 从子出口 import 是唯一合法方向；
- 全程：不写兼容别名、不留双轨字段（CLAUDE.md 零兼容层铁律）。

## 3. 在途变更协调（本方案落地时的并行纪律）

工作区当前有他人未提交变更（thread/notify 族：commands.ts/internal.ts/worker-pool/
agent-loop 系，`git status` 20 项）。协调规则：

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
| R1 | jsonl splitter 的 discard 语义连丢「超限残留行 + 下一完整行」（jsonl.ts:25-28，无界行吞后续一行） | 契约测试钉住现行为含真实触发形态：**分裂超限 + 后随好行**向量（07 §3）——整行单 chunk 的超限走另一分支不吞行，两形态分开钉；行为修改不在本期（改 wire 语义越权）——README 披露 + 挂账后续专项 |
| R2 | flush() 不查上限不剥 \r（jsonl.ts:58-66） | 同 R1：钉现行为不静默改 |
| R3 | host 停机不补在飞响应（除 worker 收编路径）——close() 期间晚到呼叫可能只拿到合成 failure | 04 §4-3 已披露；契约测试：close 前 call 的结算路径（host shutting down 响应或合成，二断一）；**exit 锚 stdout 'close' 保末帧冲刷不丢**（07 §3 末帧不丢向量） |
| R4 | spawn -STOP / pgrep 平台差异（CI 可用性） | 07 §7 环境裁剪纪律：降级为语义等价替身断言（注入 spawn 链/假体），断言永在——不是 skip 换绿 |
| R5 | oxlint max-lines 500（skipComments）——process.ts/connect.ts 可能超 | 文件按一一动词一文件拆细：04 §1 拆 process.ts 为 process（spawn+泵）/ heartbeat-supervisor（死线监督）两文件，背压 drain 归 transport-send；不加 lint-disable |
| R6 | host-hub 测试改 import SDK 后，测试图成环（host-hub devDep hub-client + hub-client 契约测试 spawn host-hub） | 方向核验：hub-client 的 dependencies 只有 hub-protocol；host-hub **devDependencies** 引 hub-client 仅测试用；契约测试 spawn 的是文件路径不是包名，无运行时环 |
| R7 | 在途变更同文件冲突（thread/notify 族） | §3 协调规则（待提交/worktree 隔离） |

## 5. 验收清单（逐项核销，全勾才算完成）

- [ ] U1/U2/U3 契约逐条：call 返回 response JSON 原样（永不 reject，connectHub reject
  唯一例外）；多用户组网按 06 可组装
- [ ] 03 §2 移动完成、host-hub 与 gateway 零残留副本（grep 核查）；hub-protocol 零
  @x-harness 依赖
- [ ] 04 §2/§3/§4 API 与语义逐条（id 守卫、行超限本地拒、exit 三步、close/kill、
  二段性披露）
- [ ] 05 观测面全量字段 + log/onRawLine 缝 + 心跳透传；消费端可零改接入
- [ ] 06 pool 语义逐条（去重/清槽/TTL/evict/聚合）+ 越权矩阵
- [ ] 07 测试口径全绿（单元/契约/封闭性三层）；回归用例带症状命名
- [ ] 02 §6 预算逐条：定时器 ≤2 常驻、行缓冲 16MiB、事件零缓存、pending 稳态归零断言
- [ ] 四门全绿 + 覆盖率数字如实报告（新包计入分母，阈值 90/85 不动）
- [ ] 对抗审查（契约/并发密集批次逐批 + 文档定稿轮）问题清零（入口 §4 轮次表）
- [ ] host-hub 装置迁移后其全量测试绿；gateway 测试绿
- [ ] 包 README：对外行为、二段性、观测接入、组网参考、onRawLine 生产警告、
  版本对齐由部署保证——无版本叙事
