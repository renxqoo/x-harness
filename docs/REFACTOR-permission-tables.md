# permission 底线表单源化重构（2026-09-29）

## DESIGN（定向重构方案——单单元压缩版）

**问题**：底线表提取逻辑在 `facts.ts` 与 `bash/adjudicate.ts` 双写（四对函数逐字重复），
且已产生行为分歧（实测证据）：

| 面 | 代码路径 | `cmd < sub/.env`（根集内 .env）结果 |
|---|---|---|
| 执法面 | adjudicateBash → denyReadHitOf（含 allowRoots 条件豁免） | 不拒（正确——2026-09-28 .env 裁决） |
| 事实面 | bashFactsOf → redirectFactsOf（两表 flat 直配，无豁免） | `redirectReadDeny=/**/.env`（失真） |
| 消费方 | tool-plan plan-mode decide 按 redirectReadDeny deny | plan 档误报 `redirect-read:/**/.env` |

**目标形态**：底线表三件（恒拒读/条件读/拒写 + 根集）提取与命中判定收敛为
`bash/tables.ts` 单源；facts 面与执法面消费同一函数——事实与执法永不分歧。

**不处理**：plugin.ts 314 行内聚（拆分纯搬运无行为收益）；decide.ts:205 与
autoMode 的 `outside-root` reason 同名异构（双形态有意——base 裸终态 vs auto 富化）。

## IMPLEMENTATION（施工图）

1. 新建 `packages/permission/src/bash/tables.ts`：
   - `denyTablesOf(input: BashPipelineInput): DenyTables`（sensitiveTablesOf 迁入）；
   - `denyReadHitOf(input, path)`（adjudicate 迁入——恒拒直判 + 条件表根集外判）；
   - `denyReadPatternsOf` / `denyReadOutsideOf` / `denyWritePatternsOf` 内聚为私有。
2. `facts.ts`：删四函数，redirectFactsOf 的命中改走 `denyReadHitOf`（**修复分歧**），
   tablesOf 消费 denyTablesOf；敏感面经 denyTablesOf（其 denyReadHit 已带豁免——原实现已对）。
3. `bash/adjudicate.ts`：删四函数，消费 tables.ts 导出。
4. `permission-modes/modes.ts`：两处内联 `import("@x-harness/permission").PermissionProfile`
   提顶（卫生项）。

## MIGRATION（行为映射表——重构等价锚）

**基准声明**：本表「旧」指重构前工作树态（含同日已裁决并验收的三项特性：.env 根集豁免、
full-unrestricted 钳制豁免、宿主 baseline 覆写面）——非 git HEAD（三项特性尚未提交，
对抗审查以 HEAD 对照会产生基准漂移，其清单中的翻转项均属已裁决特性非本次重构引入）。

| 旧行为（重构前工作树） | 新行为 | 等价性 |
|---|---|---|
| 执法面 denyReadHitOf 判定 | 原函数迁移（现委托 sensitive.denyReadHit 单源） | 语义等价（判定单源化） |
| 事实面 redirectFactsOf 无豁免命中 | 改走 denyReadHitOf（带豁免） | **有意变更**——修复失真（.env 裁决漏改面），非回归 |
| 事实面 sensitiveHit（tablesOf 带 allowRoots） | denyTablesOf 同构 | 等价（DenyTables 形状不变） |
| sensitiveFloorOf 总括档手拼表 | denyTablesOf 覆写 protectedWrite/denyWrite 空 | 等价（审查 #4 验证） |
| redirectFloorOf/段梯 redirectDecision 的写面 | denyWritePatternsOf 导出消费 | 等价（词序 baseline→denyRules 保持） |
| 总括档豁免面（写面让位/敏感升格/钳制跳过） | 未触碰 | 已裁决特性，非本重构变更面 |
| plan-mode `redirect-read:~/.ssh/**` 断言 | ~/.ssh 恒拒表，不受豁免影响 | 等价 |

## 测试计划

- 零翻转预期：384 用例全绿（既有锚不含「根集内 .env 重定向 + plan」组合——分歧即因此漏网）；
- 新增回归用例（症状注明）：事实面 `cmd < sub/.env` 根集内 → redirectReadDeny undefined；
  根集外 → 命中；plan 档消费面同判。覆盖率只升不降。

## 验收清单

- [x] 四门全绿（lint 0-0 / typecheck / build / test）
- [x] 回归用例含症状名
- [x] 净删重复 ≥ 30 行，单一真源成立（表提取 tables.ts 单源 + 豁免判 sensitive.denyReadHit 单源——审查 #3 处置）
- [x] 对抗审查偏差清零（#1/#2 基准漂移→基准声明落档；#3 判定双写→收敛单源；#4 卫生→清理）

## 审查处置记录（2026-09-29）

- #1/#2：映射表「旧」基准已从隐含 HEAD 改为「重构前工作树态」并声明；HEAD 对照产生的
  翻转项（相对 .env glob→绝对形、根集内豁免、总括档让位）均属同日已裁决特性，非本重构变更面；
- #3：denyReadHitOf 改为委托 sensitive.denyReadHit（表单源 + 判定单源）；
- #4：双空行清理；facts.tablesOf 保留（单消费点命名锚，注释已更新）。
