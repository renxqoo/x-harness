# PERMISSION V4 施工图

> 状态：实施中。上游：PERMISSION-V4-DESIGN.md（U9-U12）。

## 1. 目标结构

```
packages/permission/（纯机制件——零档位策略）
  facts.ts / modes.ts（协议+注册表+profileDecideOf token）/ decide.ts / adjudicate.ts /
  plugin.ts（消费 token）/ classifier / rules / grants / sensitive / bash 机制件
packages/permission-modes/（新——五档内置模式插件）
  full.ts / auto.ts / edit-confirm.ts / sandboxed-auto.ts / plan-default.ts /
  knobs.ts（knobDecideOf——旋钮映射，custom profiles 承接）/
  plugin.ts（注册五件 + provide profileDecideOf）
packages/tool-plan/（不变——planMode 经注册表覆盖 plan-default）
```

## 2. 逐模块裁决表

| 旧（V3 位置） | 裁决 | 动作 |
|---|---|---|
| modes.ts fullMode | 迁 | permission-modes/full.ts |
| modes.ts planDefaultMode | 迁 | permission-modes/plan-default.ts（+读面 posture） |
| modes.ts builtinDecideOf | 迁+扩 | permission-modes/knobs.ts → knobDecideOf（decide+posture 双面） |
| decide.ts inRoot 放行/confirmAllWrite | 迁 | auto.ts/edit-confirm.ts 的 posture |
| adjudicate.ts pipelineTail 三态+on-failure | 迁 | 各模式 posture；base 终态保留 fail-closed ask |
| plugin.ts 内置注册 | 删 | permission-modes/plugin.ts 注册 |
| plugin.ts modeDecideOf | 改 | resolve(mode)?.decide ?? tryUse(profileDecideOf)?.(profile)?.decide |
| decideFor/adjudicateBash 签名 | 扩 | +postureDecide optional |
| facts.ts | 扩 | +root 字段（edit-confirm suggestedRule 用） |

## 3. 消费方改接

| 消费方 | 动作 |
|---|---|
| harness fenceKit | 同装 permission + permission-modes |
| tool-write 抢救件（C-seam-19） | 注入 knobDecideOf（或装配 modes 插件） |
| permission 单测 helpers（adjudicate/bash-holes/bash-wrappers/bash-loosening/permission-v2/audit-v3） | helper 注入 knobDecideOf(profile) 双面 |
| 真管线测试世界（plugin.test/tool-bash/tool-write/tool-plan/sandbox） | 装配列表 + createPermissionModesPlugin() |
| tool-plan planMode | +读面 posture（plan Read inRoot 放行——V3 梯子迁出后显式化） |

## 4. 实施顺序（阶段=可回滚单元）

1. **阶段一**：permission-modes 包落地（五件 + knobs + plugin）+ base 协议扩展（posture 挂点/token/facts.root）+ base 策略净化——一个原子步（base 改了挂点就必须有模式件喂，否则全量红）。
2. **阶段二**：消费方改接（harness/宿主/测试 worlds/helpers）。
3. **阶段三**：四门 + 攻击探针 + 文档状态推进 + 对抗审查。

## 5. 行为映射表（MIGRATION 要点——等价锚）

| 场景 | V3 | V4 |
|---|---|---|
| auto+界内 write（模式在装） | allow in-root/auto/direct | autoMode.posture 同判决（exec 由 base 出口附加） |
| 无模式装配+界内 write | allow in-root（梯子在 base） | **ask（fail-closed 终态）**——唯一有意行为变更（U10 语义） |
| custom profile（hub 行） | 旋钮梯 | knobDecideOf 旋钮映射同判决 |
| plan 读界内 | 梯子 in-root allow | planMode.posture 显式（+plan-default 同） |
| sandboxed-auto opaque/unclassified | on-failure fenced allow | sandboxedAutoMode.posture 同 reason |
| full/plan 短路面 | decide 顶部分派 | 不变（挂点位置同 V3） |
