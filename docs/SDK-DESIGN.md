# SDK 件设计基线（任意 agent 平台：软序原语 + kit 组合 + 作者文档 + testkit）

> 状态：**草稿**（对抗审查前）。方法论：repo-migration-e2e-v2；行为规格 = 现有 1730 测试 + e2e 全旅程。
> **动机修正（用户裁决，2026-09-20）**：门面不是"封装一个标准 agent"，是**让开发者直接实现任意功能 的 agent 与插件**——平台而非成品。原 S2「CLI 形态 19 件套 opinionated」作废。

## 0. 目标与非目标

**目标**：任意插件集可被正确装配（顺序知识结构性消灭）；成品 = kit 目录任选 + 自有插件混入；作者有单一入口与测试装置。
**非目标**：YAML 声明式 preset（函数即配置；多产品矩阵时重启）；sdk/ACP 跨进程；npm 分发（产品阶段）；自定义驱动循环（Agent 接口已在，作者文档记路径，本波不做新驱动）。

## 1. 用户裁决

| # | 裁决 | 出处 |
|---|---|---|
| S1 | 平台化全量推进（S0/F0/F1/F2） | 2026-09-20 对话 |
| S2' | **门面 = 组合任意插件集的装配机制**（kit + topo），CLI 只是用同一机制组装出的一个成品（dogfood 证通用性）——非固定件套 | 用户纠偏 |
| S3 | 门面零业务内容：prompt 基础段经 kit/插件注入（后核销修正 1 原则）；adapters 经插件闭包注册（消灭"后置注册"仪式） | 设计裁决 |
| S4 | World 形状沿用（ctx/unload/store/archive/loop/prompt/meter/registry） | 避免双类型 |
| S5 | **新增内核原语 `Plugin.softInject`**："在场则排后，缺席则无约束"的声明式软依赖——任意组合安全性的结构基础 | 本设计（见 §2.1） |

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

- topoOrder 扩展：`for (const dep of [...inject 强制, ...softInject 过滤在场]) visit(dep)`；软名缺席跳过、不进校验 throw；环检测沿用 visiting 栈。
- **采纳方**：tool-core `softInject: ["system-prompt"]`（guidance 停靠 tryUse 必中——D6 数组序约束**结构性消灭**）+ `softInject: ["sandbox-local"]`（execEnv 停靠同款；env 缺席仍 fail-closed throw 不变）。两条数组序硬约束从"世界知识"降为"插件自声明"。
- 否决项更新：inject（硬失败，缺席世界炸）、waitFor（异步拆卸竞态）维持否决——softInject 为第三形态：同步、声明式、缺席无害。

### 2.2 `@x-harness/harness`（F0，packages/harness）：kit 目录 + World 装配

```ts
// kit = 返回正确内部接线的插件组（含自声明 softInject/inject——顺序由 loader 保证）
export const inlineSessionKit = (): Plugin[];                                  // session（内存会话）
export const durableSessionKit = (o: { root: string; onIoError? }): Plugin[];   // + jsonl 持久化/archive
export const llmKit = (adapters: readonly LlmAdapter[], retry?: RetryPolicy): Plugin[];  // llm-retry + llm + adapter 注册插件（闭包——消灭后置注册仪式）
export const toolboxKit = (o?: { gate?: PathGate; observed?: ObservedRegistry }): Plugin[]; // tools + read/write/bash/grep/task-tools（共享实例接线内包）
export const fenceKit = (o: { root: string }): Plugin[];                       // permission + sandbox-local
export const delegationKit = (): Plugin[];                                     // agent-delegation（含 checkpoint）
export const skillKit = (): Plugin[];                                          // skill
export const meterKit = (): Plugin[];                                          // token-meter
export const promptKit = (base: Plugin, appends?: readonly string[]): Plugin[];// system-prompt + 宿主基础段插件 + 追加链
export function createAgentWorld(o: { readonly plugins: readonly Plugin[]; readonly broker?: Plugin }): Promise<Result<World>>;
```

- `createAgentWorld` = loadPlugins + World 七字段提取 + 失败 ctx.dispose 兜底——**对任意插件集**工作（顺序由 inject/softInject topo 保证）；broker 只是普通插件参数（惯例位）。
- 追加段链注册逻辑自 apps/cli 迁入 promptKit（机制归 kit、内容归宿主）。
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
