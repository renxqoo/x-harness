# PERMISSION V3 设计基线——机制/策略分离（permission 降为底层件，策略归模式插件）

> 状态：**已实施**（三阶段落地 2026-09-28：U5 安全批次 → 阶段一 full 抽取 → 阶段二 plan 双形态 → 阶段三死代码清理；全量四门绿 293 文件/3234 用例）
> 上游：PERMISSION-V2-DESIGN.md（现行架构）；本次为架构内迁，**用户面行为等价**。
> 关联：tool-plan（plan 模式策略的落点）、repo-migration-e2e-v2 流程。

## 0. 背景与目标

V2 的 permission 包把**机制**（解析/分类/规则/围栏消费/审计/ask 执行）与**策略**（五档
的判决语义——尤其 plan 档的 planWriteGate/planBash 分支）写在同一裁决梯里。后果：新增
模式必须改核心文件（planBash 即证据），策略分散（plan 语义一半在 tool-plan 一半在
permission）。

**V3 目标**：permission 成为**底层机制件**——产出事实、执行判决；策略下放**模式插件**
（依赖 permission 核心）。新增权限模式 = 新增插件，核心零改动（开放封闭）。五个内置
模式成为 permission 包**内**的插件（同包依赖核心）；plan 模式策略迁往 tool-plan
（plan 插件自持全部 plan 语义——owner 重构确立的原则推到底）。

## 1. 外部契约

### 1.1 消费方与调用形态

| 消费方 | 消费面 |
|---|---|
| 宿主装配（CLI/hub fenceKit） | 核心插件 + 内置模式插件集；mode 服务（get/set）不变 |
| tool-plan（plan 模式插件） | 模式注册协议 + 事实面 + ask 执行面 |
| tools dispatch | `toolsPreExecute` 唯一执法点（permission 核心挂，不变） |
| 审计/遥测消费 | `permissionDecided` 事件（resolvedBy 语义见 1.4） |

### 1.2 模式注册协议（新）

```ts
interface ModePlugin {
  readonly id: ProfileId;                       // 词表封闭（五档名保留——用户裁决）
  decide(facts: AdjudicationFacts, ctx: ModeContext): Decision;
}
```

- **判决函数形态**（用户裁决）：模式插件不是 waterfall 上的自由中间件，而是核心调用的
  纯判决函数——同步、无 IO、无副作用；ask 的落账/记忆/审计由核心执行面统一执行。
- `AdjudicationFacts`：核心产出的全部判定输入——bash AST 分段（argv/redirects/injection/
  opaque/ask 旗面）、分类器三态（readonly/write/unclassified）、规则命中（deny/allow/
  习得，含作用域）、围栏事实、敏感面命中、路径族归属（Read/Write/Grep）、control 标记、
  界内外判定。
- `Decision`：`allow(exec?) | ask(reason, {memory: once|可记忆}, suggestedRule?) | deny(reason)`
  ——现行 Decision 结构的收窄复用。

### 1.3 核心保证的不变量（不下放，红线）

1. **显式规则权威 > 模式缺省**：deny 规则任何模式压不过（deny-beats-allow 跨作用域）；
   习得 allow 不可越过 hard-deny/injection（NEVER_MEMORIZE）；
2. **hard-deny/injection 最低保障**：核心产事实，模式对这两个面的判决**不得低于 ask**
   （核心钳制——模式写 allow 也被核心改写为 ask）；
3. **审计完整性**：每裁决一条 `permissionDecided`，resolvedBy 归因链保留
   （`mode:<id>` / `rule:<origin>` / `classifier:*` / `control-tool` 词表封闭）；
4. **ask/记忆执行面归核心**：模式只声明记忆资格，写入/消退/作用域归核心；
5. **control 直通**：isControlTool 旁路发生在模式判决**之前**（现行为不变——plan 的
   控制动词白名单在 plan 插件自己的中间件，属其策略面）。

### 1.4 事件时序契约（不变项）

- 每次工具 dispatch 恰好一条裁决审计（含 ask 批准后的终局改写，同 V2）；
- 事件词表封闭：`permissionDecided` / `permissionGrantWritten` 词表不变。

### 1.5 用户面（不变项——五档名保留，用户裁决）

- CLI `--permission` 词表、hub settings `permission.defaultMode`、WAL `session/meta`
  档位串：**词表与语义均不变**；
- 旧值处理：**断代**（用户裁决）——非词表串一律落默认档 + 告警，不建映射层
  （词表未变，实际断代面≈零，落档防将来词表变更时生歧义）。

## 2. 内部问题域

### 2.1 处理（permission 核心）

- bash AST 解析与分段旗面（injection/opaque/ask/redirects/dynamic）；
- 分类器三态 + readonly/write 词表（事实，非策略）；
- 规则匹配（glob/bash-prefix/Tool 通配/作用域合并）与习得桶（grants）；
- 路径族归属与界内外判定、围栏/敏感面事实消费；
- 模式注册表与 mode 服务；判决执行（ask 落账、记忆、审计、exec 指令推导）；
- 五个内置模式插件（**同包内**，依赖核心——用户裁决的内置形态）。

### 2.2 明确不处理（归属清单一处一定）

| 不处理项 | 归属 |
|---|---|
| plan 档策略（Write 无条件拒、bash 三态、控制白名单、owner 锚定） | tool-plan（plan 模式插件） |
| 沙箱执行/围栏事实生产 | sandbox / exec-env（核心只消费 fenceFacts） |
| 宿主 UX（CLI flag 解析、hub settings/meta 持久化、确认条 UI） | 各宿主 |
| 模式的存在性与装配选择 | 宿主装配（装哪些模式插件宿主说了算） |
| 三分法「未知即问」等**行为演进** | 本次不做（后续按讨论方案独立立项） |

## 3. 并发与性能预算

- 判决函数**同步、无 IO**（违者注册期拒绝——契约测试钉）；ask 落账异步面归核心执行层；
- 单次 dispatch 裁决开销与 V2 同量级（parse+classify+规则匹配已有实测口径；
  重构后**不新增**每裁决的分配热点——事实结构单次构造、判决函数零拷贝消费）；
- 模式注册表常驻 Map；运行期注册模式合法（同工具注册语义），注销带身份守卫。

## 4. 用户裁决落档（2026-09-28）

| # | 裁决 | 选择 |
|---|---|---|
| U1 | 模式插件组合形态 | **判决函数**（非自由中间件） |
| U2 | 模式词汇表 | **五档名保留**（plan/auto/edit-confirm/full/sandboxed-auto）——本次纯架构内迁 |
| U3 | 旧档位串兼容 | **断代**（非词表串落默认档+告警；词表未变实际面≈零） |
| U4 | 开工基线 | **直接叠加**（当前未提交文件保持原样，重构叠加其上；提交时只点名自己的文件——流程纪律） |
| U5 | 安全 bug 处置时序 | **先修后重构**——7 个安全级（P-bug-1/3/4/5 + B-bug-1/2/3）+ 每条回归用例先出独立批次，「现行代码=行为规格」基线变为修后行为 |
| U6 | 四档同值缺省归属 | **核心 fallback**——核心提供 in-root 放行/unknown ask/界外 ask 的 fallback 判决，插件显式声明可覆盖；plan/full 迁出后核心不残留档位语义 |
| U7 | full 短路与规则归因先后 | **规则归因优先**——事实层先出规则命中，full 插件 allow 时核心可用规则归因（deny 压过不变，allow 归因不再被吞）。**有意行为变更**（审计史更真），MIGRATION 行为映射表列名 |
| U8 | custom profiles 校验规格 | **以现状为规格**（settings-store 三层现状），mergeCustomProfiles 死代码删除；「行→判决函数参数化」映射机制后置单独裁决 |

## 4.1 审计结论引用（三路，2026-09-28）

- 核心面：P-bug-1~16 / P-dup-1~9 / P-mix-1~14 + decide.ts 裁决梯逐分支归属表（IMPLEMENTATION 裁决表直接输入）
- bash 面：B-bug-1~11 / B-dup-1~9 / B-mix-1~11；**B-mix-9 的 BashFacts 上提**为重构核心结构（classifyPipeline 事实面不自足的系统性修法）
- 消费方接缝：C-seam-1~28（**C-seam-19 tool-write 直调 decideFor 为最大单点破坏面**）/ C-spec-1~21（215 用例机制/策略分流基线）/ C-custom-1~10
- 修复优先序（U5 批次内）：B-bug-1（planBash 读保护缺失——当日引入）→ B-bug-2/3（静默越权）→ P-bug-1/3/4/5（规则/授权面）

## 5. 与 V2 的关系

- V2 文档降为历史基线；行为规格 = **现行代码 + 现行测试**（旧测试当规格——流程 §5）；
- V2 的裁决（U1-U16 等编号）在 V3 中语义不变的直接沿用；受架构影响的（如 U10 plan 闸）
  在 MIGRATION 中列行为映射表。
