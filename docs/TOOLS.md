# Tools 件方案（工具注册表 + 执行管线）

> 状态：已核销（方案审 12 + 代码审 7 条全部处置；四门全绿）
> 级别：中（新外部契约、并发分类语义；消费方为 agent-loop）
> 上游：docs/AGENT-LOOP.md §3（处置 P16 并发分类 fail-closed；调度器归 loop）
> 参照取舍（用户裁决：参考功能不复制、基于思路写最优代码）：
> - **取自 DSH**：pre-execute 权限否决 + execute 包裹的两段管线骨架；`isConcurrencySafe(args) === true` 才并行的 fail-closed 分类；校验错误回显收到的参数（模型自纠错）；全量错误归一化（含不可打印抛出值兜底）；执行后 abort 覆盖成功结果（success superseded）。
> - **取自 pi**：结果即返回值（`concludesTurn`/`additionalContexts` 进 outcome）；**引入 TypeBox**（用户裁决）：`Type.*` 构造 schema（类型安全）、`defineTool` 泛型助手保持 `Static<T>` 参数推断、`Value.Errors` 产违规清单——不自写校验子集。
> - **砍掉（无对应消费者）**：DSH 的 ask 审批流与 approval 服务接缝（未建件，deny-only）；post-execute accept/block 段与 value 替换、markCanonical 防伪、finalizeContent、presentationMeta（服务于值/投影契约与 UI 回放，我们 content 是 string）；tools/result emit（观察走 session 落账事件）；scope 分层注册/restrict/guard（delegation 里程碑）；pi 的 prepareArguments 垫片与 deferred-tools（无回放装置）。
> - **归 loop 件**：并发池调度与排他屏障、abort 双码分类、截断消息守卫（args 侧）、args 原文保留策略。

## 1. 契约

### 1.1 类型

```ts
import type { Static, TSchema } from "@sinclair/typebox";

export interface ToolSchema { readonly name: string; readonly description?: string; readonly inputSchema: TSchema }

export interface ToolExecContext { readonly callId: string; readonly name: string; readonly signal: AbortSignal }

export interface ToolOutcome {
  readonly content: string;
  readonly isError?: true;
  readonly aborted?: true;               // 结构化判别：loop 据此区分 abort 双码（超时/用户取消）
  readonly concludesTurn?: true;         // 工具显式终结 turn（易失：不进任何 session 事件——repair 后丢失是已知语义）
  readonly additionalContexts?: readonly { readonly content: readonly { readonly type: "text"; readonly text: string }[] }[]; // 仅 text 块（tool_use 会被适配器丢弃，形状门直接拒）
}

export interface ToolDefinition extends ToolSchema {
  /** 严格 true 才可并行（缺省/抛错/非 true 一律 exclusive——fail-closed） */
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolOutcome>;
}

/** 泛型助手：保持 Static<T> 参数推断——execute 拿到类型安全的已校验参数 */
export function defineTool<T extends TSchema>(def: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: T;
  readonly isConcurrencySafe?: (args: unknown) => boolean;
  execute(args: Static<T>, ctx: ToolExecContext): Promise<ToolOutcome>;
}): ToolDefinition;

export interface ToolCallRequest { readonly callId: string; readonly name: string; readonly args: unknown; readonly signal: AbortSignal }
export type PreExecuteDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };
```

### 1.2 服务（token：`toolRegistry`）

```ts
register(def: ToolDefinition): Disposer;          // 重名注册 throw；运行期注册新名合法（schemas 即时反映）
get(name: string): ToolDefinition | undefined;
schemas(options?: { sessionId?: string }): readonly ToolSchema[];  // 分层投影：根层 − 会话 restriction（缺省=全量，W2A）
scoped(sessionId).restrict(filter | "deny-all"): Disposer;         // 会话层收窄（X15 沿树只收窄；sessionDisposed 自动注销）
restrictionOf(sessionId): ToolFilter | undefined;                   // 读回——血缘收窄输入源
concurrencyOf(name: string, args: unknown): "parallel" | "exclusive";   // O(1) 查表；分类器抛错吞为 exclusive
dispatch(request: ToolCallRequest): Promise<ToolOutcome>;               // 管线入口（§1.3）
```

- **注册方自负生命周期绑定**：registry 是纯服务，不感知 context 层；消费方调用 `register` 后必须自行 `ctx.effect(off)`——否则插件回卷后工具残留（内存泄漏）。
- **并发分类吃未校验原始 args**（时序声明）：分类先于校验，`isConcurrencySafe` 自行防御垃圾输入；抛错 → exclusive（fail-closed）。

### 1.3 执行管线（token：`toolsPreExecute` waterfall、`toolsExecute` waterfall）

```
dispatch(request) —— 函数体整体 try/catch，任何逃逸 throw → isError outcome（见末条）：
  0 形状守卫：request.signal 缺失/非对象/name 非 string → outcome { content: "invalid-request", isError }
  1 abort 检查（原始 signal）：已 abort → outcome { content: "aborted", isError, aborted }
  2 lookup：get(name) 未命中 → outcome { content: "unknown-tool:<name>", isError }
    （早退理由：unknown-tool 非权限问题、无 schema 可校验；审计走 loop 的 tool/result 落账）
  3 pre-execute waterfall（载荷 {callId, name, args}——未校验原始 args，权限策略看原始输入；final = {kind:"allow"}）：
      中间件**必须调 next**（内核 I2 不变量）；拒绝方式 = 调 next 后返回 deny（最外层 deny 胜）。
      返回值形状门：非 {kind:"allow"|"deny"} 判别形态 → deny { reason: "invalid-decision" }（fail-closed）。
      deny → outcome { content: "denied:<reason>", isError }
  4 abort 复查（原始 signal）
  5 参数校验（TypeBox）：violation → outcome { content: 违规清单 + "received: <args 原文>", isError }
  6 execute waterfall（载荷 = request（含 signal），final = 真执行 + 归一化）：
      中间件可换 signal（重建对象调 next——readonly 是编译期约束，合法）做超时/取消包裹，或后处理 outcome；
      **args/name/callId 不可换**——final 入口做同一性断言，替换 → outcome "request-altered"（换 args 击穿「校验先行于执行」的契约，fail-closed）。
      final：execute(args, {callId, name, signal: 入 final 的 signal}) →
        抛错 → signal 已 abort ? { content:"aborted", isError, aborted } : { content: 归一化消息, isError }；
        正常返回但 signal 已 abort → 覆盖为 aborted outcome（success superseded——DSH 同语义）；
        正常返回 → outcome 形状门。
```

- **错误归一化（total）**：`error instanceof Error ? message : String(v)`；String 再抛 → `<unprintable thrown value>`。dispatch **永不 reject**（两段 ctx.dispatch 与全部自有步骤都在 try/catch 内）。
- **outcome 形状门**：execute 返回非对象/undefined/null → `invalid-tool-output`；`content` 非 string → 拒；三布尔标志（isError/aborted/concludesTurn）**出现即必须为 true**（显式 false 是契约错误——与 session 词表同口径）；`additionalContexts` 非数组或含非 text 块 → 拒；**未知字段放行**（消费面只读白名单字段）；content 空串合法；`isError + concludesTurn` 并存合法（错误结果终结 turn）。
- **载荷冻结语义**：内核对 waterfall 载荷 deepFreeze——args 冻结（工具作者只读契约，strict 下变异即 throw）；AbortSignal 为 exotic，deepFreeze 只走自有可枚举键、不破坏内部槽（附回归测试）。
- **管线派发层**：waterfall 恒自 toolsPlugin 装配层派发（内核按 dispatch 层链收集监听）；delegation 里程碑引入 per-agent 管线时再裁决。

### 1.4 参数校验（TypeBox，用户裁决引入）

- 依赖 `@sinclair/typebox`（**仅驻本包**，core/session 零外部依赖不变）：`Type.*` 构造（编译产物即 JSON Schema）；校验用 `@sinclair/typebox/value` 的 `Value.Errors(schema, value)`。
- **只许 `Type.*` 构造**（审查处置 #3，实测：`Value.Errors` 按 `[Kind]` symbol 派发，无 Kind 的手写 JSON Schema 一律 throw；`TSchema` 类型层手写对象不可赋值）——原「运行时兼容手写」承诺作废。register 探活为**结构性 Kind 巡检**（代码审 F2：探活值驱动的求值对零错误路径不求值，optional/items 下的垃圾节点漏检；巡检递归 properties/items/anyOf/… 断言每个子节点有 `[Kind]`，与探活值无关）。
- 校验语义为 **TypeBox 支持集**（非全量 JSON Schema）：不认识的关键字静默忽略（已知语义）；派发看 Kind 不看 `type` 字段。**严格校验、无强制转换**（用户裁决）：null/缺省/类型不符一律违规，回显让模型自纠错——不抄 pi 的宽容链。
- **schema 不落账**：TypeBox schema 带符号修饰键，JSON 序列化静默丢弃 ✓ 兼容 LLM 传输；session 事件只记 `ToolRef{name, description}` 摘要（不变量，防将来误加）。

## 2. 问题域

**处理**：注册/查询/快照；并发分类；dispatch 管线（形状守卫→abort→lookup→否决→校验→包裹执行→归一化）；outcome 形状门。

**不处理**：

| 项 | 归属 |
| --- | --- |
| 并发池调度、排他屏障、abort 双码判别规则、未启动合成结果 | agent-loop（tool-calls.ts） |
| args 的 JSON.parse 与原文保留（无效 JSON 传原文字符串进校验→违规回显） | agent-loop |
| 截断消息守卫（args 侧 salvaged 不执行） | agent-loop |
| **outcome.content 尺寸治理（落账前截断）** | agent-loop 落账策略（写进其文档测试口径；tools 不做隐式截断） |
| 权限/超时/重试策略本体 | 挂 `toolsPreExecute`/`toolsExecute` 的策略插件 |
| ask 审批交互 | 未建件；deny-only，需要时立 approval 件再扩 PreExecuteDecision |
| scope 分层注册/restrict | delegation 里程碑 |
| 工具内串行（同文件互斥） | 工具自身模式（pi 的 withFileMutationQueue 思想） |
| 注册方的 effect 绑定 | 消费方（§1.2 契约） |

## 3. 并发/一致性预算

- registry：单 Map；register/unregister/get/concurrencyOf O(1)；schemas O(n)（n=工具数，几十级）。
- dispatch：六段串行，无定时器、无内部队列；每 call 恰一次 pre-execute 与 execute waterfall 派发；无共享可变态（不同 call 并发进入安全）。
- outcome 不冻结（loop 落账时经 session 物化）。

## 4. 拆分

```
packages/core/tools/src/
  tokens.ts     # toolRegistry 服务 + toolsPreExecute/toolsExecute waterfall
  types.ts      # §1.1 全部类型 + defineTool
  validate.ts   # TypeBox 校验封装：violationsOf(schema, value) → 违规清单（path + 信息 + args 回显格式化）
  registry.ts   # createToolRegistry（register 探活/形状门、get、schemas、concurrencyOf）
  dispatch.ts   # createDispatcher（§1.3 六段管线，整体 try/catch）
  plugin.ts     # toolsPlugin（name: "tools"，无 inject；装配 registry + 管线桥）
  index.ts      # barrel
  __test__/     # validate/registry/dispatch/plugin 四测试文件
```

依赖方向：`tools → core + session（仅类型）+ @sinclair/typebox`；无反向。

## 5. 实施顺序

1. validate + registry + 单测；2. dispatch + plugin + 单测；3. 四门；4. 代码对抗审查 + 处置；5. 收口一提交。

## 6. 裁决与审查处置

用户裁决：引入 TypeBox（§1.4）；严格校验无强制转换；TypeBox 仅驻本包；参照取舍表。
默认裁决：重名注册 throw；deny-only；dispatch 永不 reject；未知 outcome 字段放行（消费面白名单）；三布尔标志出现即必须 true。

代码审处置（7 条，全部实测锤实）：F1 core `errorText` 补 total 守卫（hostile toString 曾令 dispatch reject）；F2 探活改结构性 Kind 巡检；F3 final 同一性断言（args/name/callId 不可换 → request-altered）；F4 删 INVALID 共享单例；F5 注册即 deepFreeze(def)（schema 注册后不可被静默替换）；F6 gateOutcome/normalizeThrown 的 hostile getter 守卫；F7 formatArgsEcho 的 Symbol/BigInt 无损文本化。

审查处置（12 条）：#1 deny=调 next 后返回（内核 I2），决策形状门 fail-closed；#2 dispatch 整体 try/catch（含逃逸中间件 throw 与 ctx 层回卷 throw）+ 形状守卫；#3 砍手写 JSON Schema 兼容（实测 Kind 派发），「全量语义」改「TypeBox 支持集」；#4 outcome 加 `aborted?: true` 判别 + 正常返回遇 abort 覆盖（success superseded）+ 两处 signal 来源写明；#5 content 尺寸治理归 loop（不处理表）；#6 additionalContexts 限 text 块 + concludesTurn 易失性写明；#7 形状门七个子裁决补齐（§1.3）；#8 注册方自负 effect 绑定 + 运行期注册合法；#9 管线派发层注记；#10 顺序三点裁决（abort 提前/unknown 早退理由/pre 收原始 args）；#11 载荷冻结语义 + 回归测试；#12 计数与复杂度描述修正、§7 补路径。

## 7. 测试口径

- **契约级**：token 词表（3 个：service + 2 waterfall，名与模式锁定）；dispatch 路径矩阵逐条（invalid-request / aborted-先 / unknown-tool / deny（含中间件返回垃圾决策→denied:invalid-decision）/ 校验违规回显（含 args 为字符串原文）/ 正常 / execute 抛错归一化 / 正常返回遇 abort 覆盖 / aborted 判别字段）。
- **形状门矩阵**：非对象返回 / content 非 string / isError:false / concludesTurn:false / additionalContexts 空数组（合法）/ 含 tool_use 块（拒）/ 未知字段（放行）/ content 空串（合法）。
- **校验表驱动（TypeBox）**：各 Type 正反例、Optional/缺失、Integer 边界（1.5/NaN/−0）、Enum、嵌套 Object/Array、`received:` 回显、args undefined/null、register 探活（垃圾 schema throw、合法 schema 过）。
- **并发分类 fail-closed**：true→parallel；缺省/false/抛错/非布尔/未知工具→exclusive。
- **registry 生命周期**：disposer 注销、重名 throw、运行期注册新名后 schemas 反映、注册方 effect 绑定模式演示（plugin.test）。
- **管线交互**：pre-execute 中间件调 next 后返回 deny（最外层胜）；execute 中间件换 signal（AbortSignal.timeout 短时限 + 慢工具 → aborted outcome）；中间件后处理 outcome；**中间件自身 throw → 逃逸归一化 internal outcome（dispatch 不 reject）**；冻结载荷回归（args Object.isFrozen、signal 仍可 throwIfAborted）。
- **回归**：发现的每个 bug 一条用例，用例名注明症状。

## 8. 验收清单

- [ ] §1.1–§1.4 逐条（类型/服务/六段管线/TypeBox 校验）
- [ ] §7 矩阵逐条
- [ ] 四门全绿 + 覆盖率数字如实报告（阈值不降）
- [ ] 方案审（12 条）+ 代码审两轮清零
