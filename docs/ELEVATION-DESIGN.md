# 架构升格设计基线（ELEVATION-DESIGN）

> 状态：**定稿**（2026-09-20 三路对抗审查处置完毕——事实核查/行为等价/设计漏洞；处置台账见 §7）
> 方法论：`/Users/wrr/.agents/skills/repo-migration-e2e-v2`。本仓无旧仓库——**行为规格 = 现有 1704 测试 + docs/ 已实施文档**。
> 关联：docs/ELEVATION-IMPLEMENTATION.md；docs/ELEVATION-MIGRATION-W0/W1/W2A/W2B/W2C/W3。

## 0. 目标与非目标

**目标**：把 x-harness 从「干净的小内核」升格为「**受治理的分层内核**」——对齐 dsh 审计确认的强项（scope 分层注册、投稿式内核服务、机器依赖门禁、运行时不变量），保留本仓优势（锚点定位代数、六类 token 交互面、fail-closed 纪律）。

**非目标**（本轮不做）：
- L3「工具 schema 进 prompt 装配」单数据流——重启条件：per-agent 工具面第二消费者；
- 插件配置面（typebox config schema 层）；
- 生成式架构文档门禁——只做依赖门禁脚本；
- 跨进程/多世界分布；restriction 跨重启持久（见 §3）。

## 1. 用户裁决（方向性，一次定义）

| # | 裁决 | 出处 |
|---|---|---|
| D1 | prompt 落盘走 system/message 事件。**审计修正**：链路已存在（step.ts:135-151 `anchorSystem`；step.ts:114/256 `deriveMessages`；lineage.ts forkSeed/recastSurface；compaction 感知）——落地收窄为**运行时不变量 + 指纹观测**，零词表变更 | 2026-09-20 对话 |
| D2 | prompt 与 tools 双注册表 scope 分层；删 `AgentOptions.tools` 通道，机制统一为 registry restriction | 同上 |
| D3 | system-prompt 升格内核公共投稿服务：tool-core 直接停靠 guidance，撤组合层桥 | 「内核插件可被上层依赖」 |
| D4 | `packages/core/*` 内核组 + 机器依赖门禁 | 同上 |
| D5 | 内核组外部依赖白名单 = **node 内置 + `@sinclair/typebox`**（tools 包 validate.ts 生产使用；「外部零依赖」原表述为假，弃用） | 对抗审查 V4/H-2 处置 |
| D6 | W1 停靠时序采**数组序硬约束**（sandbox/execEnv 同款先例），非 inject（9 个无 prompt 测试世界会 throw）、非 waitFor（异步拆卸竞态）——两者记为否决项及理由 | 对抗审查 V9/F-5 处置 |
| D7 | W2 拆三个迁移单元：W2a（tools restriction+读回+执行面保留）→ W2b（删通道+CLI/REPL/delegation 迁移）→ W2c（prompt 分层机制，零消费方等价重构） | 对抗审查 V11 处置 |

前置裁决沿用：三分法（description=怎么调 / guidance 段=行事守则 / 跨工具=装配方）；SYSTEM-PROMPT.md §1.4 重启条件。

## 2. 外部契约（变更面，逐签名）

### 2.1 system-prompt 服务（内核公共投稿面）

```ts
export interface SectionSpec {
  readonly name: string;
  readonly after?: string;
  readonly before?: string;
  /** 函数形：assemble 期惰性求值；抛错 → 该段降级 `[section <name> render error: <msg>]`
   *  占位不中断（段级降级）。fn 段须**会话内确定**——间歇抛错会使 anchorSystem 逐步落
   *  replace 事件（可观测告警面，见 MIGRATION-W1 §3 裁决注） */
  readonly text: string | (() => string);
}
export interface SystemPromptService {
  section(spec: SectionSpec): Disposer;                        // 根层
  variable(name: string, value: PromptVariable): Disposer;    // 根层（世界级——不分层，§3）
  scoped(sessionId: string): { readonly section: (spec: SectionSpec) => Disposer };  // 会话层（无 variable——§3 裁决）
  assemble(options?: { readonly sessionId?: string }): AssembledPrompt;
}
```

**锚定子集规则**（跨层良定义性——审查 F-3/V7 处置）：
- 会话层段的 `after/before` **只能指向根层段名**；会话层段之间不互锚 → 跨层环**构造性不存在**，注册期环检测沿用单层实现即足（会话注册时对「根层∪本会话层」视图跑同款检测兜底）；
- 会话段位次一律派生**根段当前位次**（δ/2ⁿ 的 n 按该会话层内注册序独立计数）→ 根段位次不因会话注册漂移 → **根层排序缓存可复用**；
- 无锚会话段 = 排全部根层段之后，按会话层注册序；
- 同名：会话层覆盖根层（沿用根层注册序位）；同层同名沿用既有覆盖+身份守卫。

**缓存失效（双向——审查 F-4 处置）**：合并投影缓存键 =（根层版本, 会话层版本）；根层变异 → 全部合并缓存失效；会话层变异 → 仅该会话合并缓存失效；根层缓存独立有效。

`wellKnown` 锚点词汇表（内核所有）：`{ baseCore: "base/core" }`（W1 落地，`baseCore` 保留别名一个版本周期）。

### 2.2 tools 注册表（内核）

```ts
export interface ToolRegistry {
  register(def: ToolDefinition): Disposer;                     // 根层（不变）
  scoped(sessionId: string): {                                 // 会话层（本轮仅 restrict——§3）
    restrict(filter: readonly string[] | "deny-all"): Disposer;
  };
  /** 读回：该会话当前生效 restriction（X15 沿树收窄的输入源——审查 V2 处置） */
  restrictionOf(sessionId: string): readonly string[] | "deny-all" | undefined;
  schemas(options?: { readonly sessionId?: string }): readonly ToolSchema[];
  get(name: string): ToolDefinition | undefined;               // 世界视图（不变）
  dispatch(...): Promise<ToolOutcome>;                          // 世界视图（不变——执行门禁见 §3）
}
```

- **执行面门禁保留**（审查 V1/F-1/H-1 处置，反转原「不处理」裁决）：`executeToolCalls` 的 `allowedTools` 拦截（tool-calls.ts `denyNotAllowed`，配对落账 `tool-not-allowed:<name>` isError）**不删**——改由 step 以 `schemas({sessionId})` 投影名集喂入。理由：llm 层不校验 tool_use 名（pi-context 仅整形），「模型不可见即不可调」前提为假；fork 播种父历史、resume 收窄后重放历史两场景都靠执行面兜底。
- `restrictionOf` 消费方：delegation `narrowTools`（spawn.ts:142）、revive 重放（plugin.ts:138 `parentToolsOf` 改读此面）。

### 2.3 AgentOptions / ResolvedOptions（破坏性，W2b）

- 删 `tools?: readonly string[]`（agent-loop/src/types.ts:21 AgentOptions；step.ts:42 ResolvedOptions）。
- CLI `--tools/--exclude-tools/--no-tools` 语义经 restriction 等价迁移（矩阵见 MIGRATION-W2B §5）；REPL `/new`、`/model`、`/resume` 经 **makeNext 单点重注册**（审查 F-2 处置——spread 继承路径 typecheck 不报错，须专项测试）。
- `systemPrompt?: string` 静态串通道保留（优先于 assemble，step.ts:138 包契约不变）。

### 2.4 会话事件词表：零变更（D1 审计修正）。指纹不进事件体。

### 2.5 CLI 外部行为：不变（逐 flag 等价矩阵见 MIGRATION-W2B §5）。

## 3. 内部问题域

**处理**：分层注册、合并投影（锚定子集规则）、restriction 投影+执行面拦截、投稿停靠、依赖门禁、落盘不变量、指纹观测。

**明确不处理**（每项写清归属）：
- ~~dispatch 期 restriction 执行门禁~~ → **反转：本轮处理**（§2.2，复用既有 allowedTools 面）；
- variable 的 scope 分层 → 无按会话分变量需求；世界级变量（如 `agentTypes` 全量清单）与未来 scoped section 的插值错配记**重启条件**（首个 typed-persona 走 scoped section 时一并裁决）；
- tools 会话层 `register`（同名覆盖= schema/execute 错配脚枪）→ 挂账：出现会话层工具定义需求时与 dispatch 按层解析一起做；
- prompt 段随 restriction 过滤（收窄子代理不显示 `tool/<受限名>` 段）→ 需 prompt 感知 tools 投影（L3 邻域），记重启条件；
- **restriction 生命周期 = 每进程生命期一次注册**（create/resume/revive 皆可注册或重放；进程内中途变更不做；跨重启不持久——无 flag resume = 显式全集，与现状等价[现状即放开，resolve-agent-options.test.ts:47-50 钉死]）；
- L3 工具进装配 → agent-loop 取数路径（§0 重启条件）。

## 4. 并发与性能预算（违反 = 缺陷）

| 热路径 | 预算 | 说明 |
|---|---|---|
| `assemble`（合并投影+插值+指纹） | ≤1ms @ 100 段/50KB | 根缓存复用 + 会话段 O(本层) 插入；合并缓存键=(根版本,会话版本) |
| `schemas` 投影 | ≤0.1ms @ 40 工具 | 冻结数组+名单过滤 |
| `restrictionOf` | O(1) Map 查 | 新增面 |
| 变量/段文本函数 | 禁 IO、禁 await、同步快速、**会话内确定** | assemble 热路径内 |
| 全局定时器 | 本轮新增 0 | — |

## 5. dsh 对表缺口收口表

| 缺口 | 收口 |
|---|---|
| scope 分层注册（收窄一致性） | W2A/W2C |
| 投稿式内核服务+锚点中心分配 | W1 |
| 机器依赖门禁 | W0 |
| 运行时不变量（模型可见必落盘） | W3 |
| ~~prompt 不落盘~~ | 不存在（D1 审计修正） |
| 每步全量重装配无缓存 | 非缺口（本仓有排序缓存+指纹） |

## 6. 风险登记

| 风险 | 缓解 |
|---|---|
| 删通道漏改（spread 继承路径 typecheck 不报） | 消费方全集 = step.ts:204/335、resolve-agent-options、spawn.ts:142、revive.ts:82、plugin.ts:138、run-repl.ts:140（spread）——W2B 表逐行+专项测试 |
| REPL 切换丢白名单（/new 新 id、/model 同 id dispose→resume） | makeNext 单点重注册；session-disposed 挂注销与重注册闭环 |
| 分层缓存陈旧 | 双向失效（§2.1）；确定性回归（两次 assemble 逐字节相等） |
| 会话层泄漏 | disposer 挂 sessionDisposed；泄漏回归用例 |

## 7. 对抗审查处置台账（2026-09-20，三路）

**必须改方案（已改）**：V1/F-1/H-1 执行面门禁保留（§2.2/§3 反转）；V2/F-6 `restrictionOf` 读回面（§2.2）；V3/F-7 W0 纯移动证伪→裁决表补 vitest/tsconfig/build/测试路径（MIGRATION-W0 §3）；V4/H-2 typebox 白名单（D5）。
**应补裁决（已补）**：V5 门禁扫 src import 说明符（IMPLEMENTATION §3 强形式）；V6 生命周期=每进程一次+resume 语义措辞修正（§3）；V7/F-3/F-4 锚定子集+双向缓存（§2.1）；V8/F-8 scoped 面删 variable（§2.1）；V9/F-5 数组序硬约束（D6）+两处陈旧注释勘误（MIGRATION-W1 §3）；V10/F-12 W3 断言三口径（MIGRATION-W3 §3）；V11/F-11 W2 拆分（D7）+M-1 降级为等价重构（MIGRATION-W2C）。
**低（已修）**：行号/文件名笔误五处；包计数 28；F2「scope 零消费方」表述改写（agent-loop plugin.ts:116/137 已用 `agent:<sessionId>` 层键——registry 分层键用 SessionId 与 dispatch `ToolExecContext.session` 对齐，映射关系在此注明）。
