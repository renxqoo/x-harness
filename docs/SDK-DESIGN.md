# SDK 件设计基线（任意 agent 平台：软序原语 + kit 组合 + 作者文档 + testkit）

> 状态：**草稿**（对抗审查前）。方法论：repo-migration-e2e-v2；行为规格 = 现有 1730 测试 + e2e 全旅程。
> **动机修正（用户裁决，2026-09-20）**：门面不是"封装一个标准 agent"，是**让开发者直接实现任意功能 的 agent 与插件**——平台而非成品。原 S2「CLI 形态 19 件套 opinionated」作废。

## 0. 目标与非目标

**目标**：底层只开放**三个域的基础接口**——对话上下文（进/出/持久/注入/提示）、工具（注册/可见性/调用管线）、循环（步进/拨号/失败/流/终态）；任意插件集可被正确装配（顺序知识结构性消灭）；成品 = kit 目录任选 + 自有插件混入；作者有单一入口与测试装置。
**反混乱五原则**（新拦截面的准入门槛，与 F2 契约规矩同源）：①词表封闭（一面一 token，payload 冻结）②洋葱不变量（中间件必须调 next，否决语义唯一）③落账不变量（改写版即日志版）④**最少面原则**（新 token 须证明现有面组合无法表达）⑤声明式顺序（softInject）。
**非目标**：YAML 声明式 preset（函数即配置；多产品矩阵时重启）；sdk/ACP 跨进程；npm 分发（产品阶段）；自定义驱动循环（Agent 接口已在，作者文档记路径，本波不做新驱动）。

## 1. 用户裁决

| # | 裁决 | 出处 |
|---|---|---|
| S1 | 平台化全量推进（S0/F0/F1/F2） | 2026-09-20 对话 |
| S2' | **门面 = 组合任意插件集的装配机制**（kit + topo），CLI 只是用同一机制组装出的一个成品（dogfood 证通用性）——非固定件套 | 用户纠偏 |
| S3 | 门面零业务内容：prompt 基础段经 kit/插件注入（后核销修正 1 原则）；adapters 经插件闭包注册（消灭"后置注册"仪式） | 设计裁决 |
| S4 | World 形状沿用（ctx/unload/store/archive/loop/prompt/meter/registry） | 避免双类型 |
| S5 | **新增内核原语 `Plugin.softInject`**："在场则排后，缺席则无约束"的声明式软依赖——任意组合安全性的结构基础 | 本设计（见 §2.1） |
| S6（修订） | T1 全量（F0 拦截面三缺口 + F0.5 token 治理 + 契约规矩）；**T2 四 seam 降级**：settings/state/credentials/telemetry 经「需动底层才能实现吗」检验——全部零地基改动可写成纯插件 → 不进底层议程，降为 F2 能力插件模式章 + 真实需求时一方参考插件 | 2026-09-20 对话（「底层开放基础接口，不过度实现」） |
| S7 | seam 形态 = **自包含上层包**（服务 token + 类型 + 缺省提供方 + 插件，permission/sandbox 同款模式）——不动内核，契约随包走 | 设计裁决 |

## 2. 外部契约

### 2.1 内核：`Plugin.softInject?: readonly string[]`（S0，packages/core/context）

```ts
export interface Plugin {
  readonly name: string;
  /** 硬依赖（topo + 缺席 throw——现行语义不变） */
  readonly inject?: readonly string[];
  /** 软依赖：点名插件在场则排其后；缺席则无约束不报错 */
  readonly softInject?: readonly string[];
  apply(ctx: Context): Disposer | void | Promise<Disposer | void>;
}
```

- topoOrder 扩展：`for (const dep of [...inject 强制, ...softInject **先 byName.has 过滤**再 visit])`（缺席软名直接跳过——照抄硬路径的 `visit(byName.get(dep) as Plugin)` 会在 undefined 上 TypeError）；环检测沿用 visiting 栈。
- **软-软环裁决（F-04）**：双向软依赖（A softInject B 且 B softInject A）= 约束矛盾 → **throw**（诚实暴露；数组序世界不失败是偶然不是语义）。硬+软重复声明同一插件：第二次 visit 命中 done 短路，无害。自软锚 throw（cyclic 文案）。
- **主张收窄（F-05）**：softInject 消灭的是 **apply 期服务停靠约束**；中间件注册序（同 waterfall 上多监听器的相对序）与无边 prompt 尾序是另两个顺序面——前者由"序敏感插件硬 inject 协作方"惯例承载（作者文档），后者由后置注册惯例承载（F-02）。
- **采纳方（F-01 处置——A2 原审计"两条"失真，实为五处 apply 期停靠）**：
  - tool-core：`["system-prompt", "sandbox", "permission"]`（guidance 停靠 / execEnv 停靠 / **permissionGrants apply 期闭包捕获**——tool-plugin.ts:59-61 晚注册 permission = 会话授权根静默丢失，反例 1）
  - agent-delegation：`["permission", "session-persistence-jsonl"]` + 工厂条件并入 `options.mailbox !== undefined ? ["session-mailbox"] : []`（grants setRootOverride 静默 / archive tryUse 复活禁用 / mailbox 在场假阴性 throw——plugin.ts:109/128/170-172，反例 2-4）
  - env 缺席仍 fail-closed throw 不变。数组序硬约束从"世界知识"降为"插件自声明"。
- 否决项更新：inject（硬失败，缺席世界炸）、waitFor（异步拆卸竞态）维持否决——softInject 为第三形态：同步、声明式、缺席无害。

### 2.2 `@x-harness/harness`（F0，packages/harness）：kit 目录 + World 装配

```ts
// kit = 返回正确内部接线的插件组（含自声明 softInject/inject——顺序由 loader 保证）
export const inlineSessionKit = (): Plugin[];                                  // session（内存会话）
export const durableSessionKit = (o: { root: string; onIoError? }): Plugin[];   // + jsonl 持久化/archive
export const llmKit = (adapters: readonly LlmAdapter[], retry?: RetryPolicy | Record<string, RetryPolicy>): Plugin[];  // llm-retry + llm + N 个 adapter 注册插件（**名按 adapter.name/index 铸唯一**——F-06：固定名多实例会重名 throw；retry 支持 per-provider map——F-07.3）
export const toolboxKit = (o?: { gate?: PathGate; observed?: ObservedRegistry; env?: ExecEnv }): Plugin[]; // tools + read/write/bash/grep/task-tools（共享实例接线内包；env 透传给无围栏世界——F-07.2）
export const fenceKit = (o: { root: string }): Plugin[];                       // permission + sandbox
export const delegationKit = (): Plugin[];                                     // agent-delegation
export const checkpointKit = (): Plugin[];                                     // session-checkpoint（**独立 kit**——F-11：与 delegation 零共享面，绑死则"要 delegation 不要 flush 屏障"不可表达）
export const skillKit = (): Plugin[];                                          // skill
export const meterKit = (): Plugin[];                                          // token-meter
export const promptKit = (base?: Plugin): Plugin[];                            // system-prompt + 宿主基础段插件（base 可选——F-07.1：--system-prompt 整替时 base/appends 俱省；appends 不在此——F-02）
export function createAgentWorld(o: { readonly plugins: readonly Plugin[]; readonly broker?: Plugin }): Promise<Result<World>>;
```

- `createAgentWorld` = loadPlugins + World 七字段提取 + 失败 ctx.dispose 兜底——**对含五服务（session/agent-loop/system-prompt/tools/token-meter）的插件集**工作（F-03 处置：提取 ctx.use 缺服务即 fail-closed throw → dispose → {ok:false}——**有意裁决**，防"装配成功但字段缺席"的半态；最小集直接用 loadPlugins，作者文档记双入口）。
- **appends 留宿主后置注册（F-02 处置）**：无边段落尾位次=纯注册序（registry TAIL_BASE+regIndex），kit 化 apply 期注册会使尾序翻转为 [cli-user-*, tool-* guidance 段]（现状相反）且无单点位可全保（baseCore 亦无边尾段）——appends 保持 loadPlugins 后宿主注册（CLI 现仪式不变，作者文档记惯例）。
- CLI = dogfood：build-world 改为上述 kit 组合（行为零变化）；e2e journey 的 7 插件子集 = 另一组 kit 组合（inlineSession + llm + prompt 空 + toolbox 子集…或保持手排——S2' 裁决：journey 逐步换用，最小子集允许手工）。

### 2.3 `@x-harness/testkit`（F2）：textScript / scriptedAdapter / fakeTool（原案不变）。

### 2.4 `docs/PLUGIN-AUTHORING.md`（F1）五块（原案），总表首行加"组装任意 agent → kit 目录 + 自有插件"。

## 3. 内部问题域

**处理**：softInject 原语与采纳、kit 目录、World、CLI/journey 换用、文档、testkit。
**不处理**（归属）：会话建立/resume（宿主）；审批 UI（宿主 broker）；providers 探测 IO（宿主）；自定义驱动（Agent 接口已在，作者文档记路径）；每 agent 异构能力集（delegation restriction/scoped 已覆盖工具面与 prompt 面）。

## 4. 并发与性能预算

softInject 仅装配期拓扑计算（O(V+E)）零运行时开销；kit 为纯装配；无新增定时器/IO。

## 5. 风险登记

| 风险 | 缓解 |
|---|---|
| softInject 破坏现行加载序（隐性依赖某序的世界） | S0 等价锚：1730 测试 + e2e 零改写通过；并加「乱序装配探针」用例（tool-* 在 systemPrompt 前 → guidance 仍停靠） |
| kit 边界吸业务 | S3 判据：内容经参数注入；审查专项 |
| CLI 换用漂移 | F0 等价锚：CLI 全测试 + e2e 零改写 |
| softInject 名漂移（改名失配=静默退化为数组序） | 门禁可加：tool-core 声明的软名在本仓插件名清单内（实施期裁决成本） |


## 6. T1 地基补全（F0/F0.5）

### 6.1 F0 拦截面（agent-loop/tools/llm 三个新 waterfall——契约级，core 不动）

```ts
// ① pre-step 改写：enter 可携重写消息（落账走重写版——「模型可见必落盘」不变量保持：重写版即日志版）
export type PreStepDecision = { kind: "enter" } | { kind: "enter"; messages: readonly InboxEntry[] } | { kind: "reject"; reason: string };
// 载荷含 claim（领取批次——改写输入源；messages 为全史观察面）
// ② assistant 落账前纠：settle 与 append 之间（content/stopReason 可改写；落的是改写后版本）
export const agentAssistantSettle = defineWaterfall<{ session; turn; step; content; stopReason; signal }, { content; stopReason }>("agent/assistant-settle");
// ③ 流拦截：包 adapter.stream（包裹/截断/注入帧；settle 仍以落账版为准——流拦截只影响实时面）
export const llmStream = defineWaterfall<LlmRequest, AsyncGenerator<LlmChunk>>("llm/stream");
```

### 6.2 F0.5 token 词表治理

- plugin-manager `tokenTable.set` 前查同名异体（不同对象同 name）→ **install 期 throw**（fail-closed）。
- well-known 治理规矩（并入 F2 文档）：token 随其服务定义包发布；消费别人服务=依赖其包（模块单例保证对象同一）；禁止第三方复用平台 token 名。

## 7. 能力插件模式（原 T2 四 seam——降级裁决）

**检验标准**：「这个能力需要动底层才能实现吗？」settings/state/credentials/telemetry 四者全部**否**——service token 定义在上层包 + `ctx.provide` 即成能力 seam（permission/sandbox 同款形态），底层零改动。故不设地基波次，F2 作者文档立「能力插件模式」范式（token 定义/提供方可选换/消费方 tryUse 优雅降级），真实消费者出现时作一方参考插件实现（可换可弃非平台承诺）。原 §7.1-7.4 契约草案降为模式示例素材。

## 8. 契约稳定性规矩（并入 F2 作者文档）

冻结面：Plugin 接口/六类 token 形状/token 名词表；pre-stable 面：waterfall payload（变更须迁移说明）。版本化：包版本 + 变更日志（发布策略属产品阶段挂账）。

## 8.5 自洽走查结论（2026-09-20，三帽检验——用户裁决）

三顶帽子（终端用户/插件开发者/产品构建者）全部插件清单逐个走查接口面：**零结构缺口**（成本上限经 session/audit-event usage、记忆插件经宿主信任域自管、微调四式齐）。固化三原则：
1. **插件代码 = 宿主信任域**——围栏/权限约束模型驱动的动作，不约束插件代码（插件可直接 node:fs/自管持久化）；
2. **领域面优先，session/audit-event 是逃生舱**（有意比 dsh 收窄：主推类型面而非 firehose；同步 session/event 面仅宿主 UI 观察消费）；
3. **能力自举检验**——每个"要不要进底层"的提议先过 persona 走查（本次为首次执行）。
F0 spec 修正：settle 载荷**不带** usage（审计通道已覆盖——最少面原则应用）。

## 9. 设计审查处置台账（2026-09-20，12 项）

**必须改（已改）**：F-01 A2 审计勘误（五处停靠，采纳清单扩充+delegation 条件软名）；F-02 appends 留宿主后置；F-03 主张收窄+fail-closed 裁决。
**应补裁决（已补）**：F-04 软-软环 throw+实现约束（byName.has 先滤）+测试清单四补；F-05 主张收窄+两顺序面惯例归属；F-06 adapter 插件名铸造；F-07 kit 签名三修（promptKit base 可选/toolboxKit env 透传/llmKit per-provider retry）；F-08 作者护栏（自有插件应 softInject+名漂移静默风险——并入 F2 陷阱表）；F-09 软名锚插件名 vs 服务 token 的错位（作者文档言明；token 锚定升级挂账）。
**挂账**：F-10 testkit 回落参数化（F3 动工时改 spec——四 journey 回落形态不一：文本/(exhausted)/error-finish 帧）；F-12 测试计数口径写死（F1 前定：`bun run test` 报告数）；F-11 已处置为拆 checkpointKit。

## 10. P1 波（plugin-api——自洽走查后新增）

纯函数 archetype 层（packages/plugin-api）：transform/veto/tap × 三域 + tapSessionEvents 逃生舱——**零新语义零新 token**，全部为既有面的语法糖；next 纪律/洋葱序结构性保证。详见 SDK-MIGRATION-P1-PLUGIN-API.md。波次序：F0 → **P1** → F0.5 → S0 → F3 → F1 → F2。


## 11. 终态台账（2026-09-20 核销）

### 交付面
| 面 | 包 | 验证 |
|---|---|---|
| softInject 原语 | core/context | 六语义专测 + 乱序探针 |
| 拦截面三缺口 | agent-loop（pre-step 改写/assistant-settle/agent-llm-stream） | 7 用例 + 收口审查 17 项处置 |
| token 词表治理 | plugin-manager | 异体拒/同体不误伤 |
| plugin-api archetype | plugin-api | 等价性 6 用例 + textOf 三助手 |
| harness kit 目录 | harness | 乱序集端到端 + CLI dogfood 零改写 |
| PLUGIN-AUTHORING | docs | 总表 14 行实指 + 零死链 |
| testkit | testkit | 3 用例 + 五 journey 换用零语义变化 |
| 验证插件 | plugin-examples | **20 个**插件 + 2 场景（多代理端到端/性能预算）覆盖全部六类 token |

### 性能预算实测（§4 → ㉒）
| 预算 | 声称 | 实测 |
|---|---|---|
| assemble @100 段/50KB | ≤1ms | 中位 <1ms ✓ |
| schemas @40 工具+restriction | ≤0.1ms | 中位 <0.1ms ✓ |
| sha256 指纹 @50KB | ≤0.1ms | 中位 <0.1ms ✓ |

### 对抗审查记录
| 轮次 | 对象 | 发现 |
|---|---|---|
| 方案审 | SDK-DESIGN/IMPLEMENTATION | 12 项（A2 审计失真/B1 放开态漂移/C1 跨层环…全处置） |
| F0+P1 审 | 拦截面 + archetype 设计 | 17 项（词表碰撞/claim 缺失/durable clear…全处置） |
| F1/F3/S0 审 | kit/softInject/testkit 实施 | 8 项（注册序方向反/adapter inject 缺/文档四勘误…全处置） |
| 终局审 | 全分支 diff | 待归档 |

### 探针插件三轮
| 轮 | 数量 | 新踩面 | 反哺内核 |
|---|---|---|---|
| 1 | 14 插件 | 全部基础面 | retry dial 补丁/claim 载荷/session 透传/layer 清理 |
| 2 | 5 插件 | defineService/registry 可变/sessionCreated | provide 同层阻断确认/header 形状摩擦 |
| 3 | 1 插件 + 2 场景 | guard token/多代理端到端/性能预算 | 三预算达标 |
