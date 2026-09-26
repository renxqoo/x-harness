# 上下文占用口径统一 + 压缩层修复（CONTEXT-TOKEN-UNIFICATION）

> 状态：草案（待对抗审查后实施）
> 级别：大（跨 compaction / autocompact / token-meter / llm / agent-loop / host-hub / pai-app 七面）
> 上游：docs/COMPACTION.md（水位与切口）、docs/TOKEN-METER.md + TOKEN-UNIFICATION.md（事实层）、docs/STREAM-PARTIAL-PERSISTENCE.md（thinking 落盘裁决）
> 事故锚点：会话 `20260925T155809-s5qad7`——85% 越 L2 线零落账（l2-no-progress 永久卡死）、92% 峰值 90.8% 未触发、L1 三批共清 744 条仅降 3-4%。

## 0. 问题总表（先结论）

| # | 问题 | 证据（真实会话重放） | 严重度 |
|---|---|---|---|
| P0 | **thinking 签名丢弃（bug）**：pi 全链路支持回传，x-harness 两处断点（pi-events 丢签名 / toPiMessages 不重建 thinking 块）→ 多轮工具调用推理链断裂 + 网关被迫自行回注 | pi 源码：`thinking_end.partial` 携签名、同模型自动回放；x-harness 实测消息面无 thinking 块 | 致命：协议载荷丢失 |
| P1 | **占用判定（usage 实报口径）与切口预算（投影估算口径）脱节** | 85% 时刻实报 851k vs 投影 nodeTokens 366k；L2 liveBudget 805k > 投影全量 → `findCutPoint` 恒 undefined → `l2-no-progress` | 致命：L2 全域失效 |
| P2 | thinking（顶层旁路字段）约八成进入服务端计费面，但不在任何可切域 | 两次独立对账：缺口 38-42 万 ≈ thinking 典型值 46 万的 82-91% | 高：占用被不可清内容推高 |
| P3 | 三套 usage 折叠并存 | meter fold（垃圾整丢+attempt）vs hub `foldStats`（无校验、漏 attempt）vs `measureContext`（锚+尾估混合） | 中：读数分叉难维护 |
| P4 | `request/context.contextWindow` 类型存在但内核从不写入 | WAL 4 条 request/context 均无该字段 → `lastWindow` 恒 undefined → 分母恒主窗 | 低：死代码/漏装配 |
| P5 | UI 把 92% 压缩摘要（replace 型 user/message，8950 字符）当系统消息整卡显示 | seq 6909 → `mapEntries` origin=system → `SystemMessageRow` 居中卡片全文渲染 | 中：UI 呈现错误 |

## 1. 事实基线（已实证，实施前的共同前提）

### 1.1 三口径数字（seq6584 = 85% 越线时刻）

| 面 | 值 | 来源 |
|---|---|---|
| 服务端实报 input | 851,459 | WAL usage（foldUsage: `input+cacheRead+cacheWrite`） |
| 投影 nodeTokens（上界口径） | 366,138 | `projectSurface` + `estimateText`（CJK 1.25/字） |
| WAL 原文 surface（典型值口径） | 645,268 | 逐事件 `estimateTokensTypical` |
| thinking 顶层累计（典型值） | 464,230 | `assistant/message.data.thinking` 求和 |
| 基底（首步实报） | 11,551 | seq14 首条 usage（系统提示词+schema+注入） |

对账：投影 366k×1.26(wire 系数)+11.5k ≈ 472k，实报 851k，**缺口 379k**；
thinking 典型值 464k × ~82% ≈ 380k。两个时点（22:12 缺口 42 万 / 85% 缺口 38 万）独立吻合。

**结论**：服务端计费面 ≈ 投影内容 × wire 系数 + thinking × ~0.8 + 基底。thinking 是占用
的实质构成但「不进投影」（STREAM-PARTIAL-PERSISTENCE 裁决：落盘但不回传）。

> 注意：thinking 进入计费面的机制未完全定源（provider 会话缓存保留 reasoning /
> pi-ai 某回放路径）。本方案按「事实如此」设计，不依赖定源结论——见 §3.1 的判据选择。

### 1.2 L1/L2/92% 在该会话的实际行为

- L1 三批（06:31 清 424 条→40%、09:01 清 226 条→66%、16:52 清 94 条→79%）：第一批有效，
  后两批收益 3-4%——`l1PreGateWorth`（清完须 < L1 线）不成立仍落账（收益可观不退避），
  但占用大头（thinking + assistant 正文）清不动。
- L2 零次：`escalateL2` 的 `liveBudget = l2Line − ledger − 20k ≈ 805k`，投影全量 366k
  全在保留预算内 → `no-cut-point` → 每步 `l2-no-progress` 静默放行（stderr 告警不进 WAL）。
- 92% 零次：峰值 908,179 < 920,000（差 1.1%）。触发后 keep=20k 切口可落（已验证
  cut 正常），但因 P1 同源问题，其触发时机系统性偏晚。
- CP 三次（60%/61%/89%）：armed 上升沿 + 段门槛（20% 有效窗）语义正常。

### 1.3 三家参照系的对应设计（阅读结论）

| 维度 | claude-code | codex | kimi-code | x-harness 现状 |
|---|---|---|---|---|
| 占用判定 | `tokenCountWithEstimation`：**最近 usage 实报 + 其后消息粗估**（`tokens.ts:226`） | `get_total_token_usage`：**最近实报 total + 其后条目估**；reasoning 单列 `get_non_last_reasoning_items_tokens` 显式加回 | `shouldCompact(usedSize)`：**全量消息粗估**（`estimateTokensForMessages`） | 实报锚 + 投影尾部估（`measureContext`）——判定与切口**两个域** |
| 估算口径单源 | `roughTokenCountEstimation`（/4 + 图片 2k + **thinking 计入**） | `estimate_item_token_count`（含 Reasoning item） | `estimateTokens`（ascii/4 + 非 ascii ×1 + **think 块计入** + WeakMap 缓存） | `estimateText`（上界）/`estimateTokensTypical`（典型值）双口径——**判定用上界、对账时两套混用** |
| 触发线 | effectiveWindow − 13k 缓冲（≈98%+ 提前量）+ 熔断 3 次 | `auto_compact_token_limit`（模型目录内置）+ 满窗强制 | `triggerRatio 0.85` | 60/70/85/92 四线 |
| 压缩产物呈现 | `isCompactSummary` → 默认时间线**不显示**，transcript 模式显示 `CompactSummary` 卡 + `compact_boundary` 一行标记 | summary 落 user 消息（`is_summary_message` 判别，UI 侧折叠） | fullCompaction 摘要归 fold 折叠 | **replace 型 user/message → origin=system 整卡显示（P5）** |
| thinking 处理 | 计入估算（`estimateMessageTokens` 显式 `block.type === 'thinking'` 分支） | 计入占用（`Reasoning{encrypted_content}` 逐条估）；压缩时随历史整体丢弃 | 计入估算（`case 'think'`） | 不进投影、不进切口、不进 L2——只在计费面 |

**参照结论**：三家共同点只有两条——①占用判定与压缩可切域**同源**（估算同一套函数、
同一个 messages 数组）；②压缩摘要对用户**默认不可见或仅标记行**。x-harness 两条都违反。

## 2. 目标与非目标

**目标**：
0. **thinking 签名全链路回传**（P0，新增——用户裁决的 bug 修复，其余各项的口径
   基线随之改变，见 §3.1）。
1. 占用判定、切口预算、收益核算三者**同域同尺**（单一 token 域，见 §3）。
2. thinking 载荷进压缩可切域（签名实构成 + 防御余量，随区间淘汰）。
3. token 计算收敛到 token-meter 单一事实层（删除 hub foldStats 第三套折叠）。
4. 92% 分母装配修复（servedWindow 落 `request/context`）。
5. UI 压缩摘要不再整卡显示（复用本仓三套既有呈现范式）。
6. 压缩保留语义改轮次（可配置，配对完整性三重防线）。

**非目标**：
- 不改 CP/L1/L2/92% 的四线拓扑与百分比（行为拓扑已裁决于 COMPACTION.md，本件只修尺）。
- thinking **文本**不进 wire（只有签名回传——协议载荷而非对话内容；跨模型降级为
  text 的行为维持 pi 现状）。
- 不引入精确 tokenizer（无 count-tokens API 依赖；估算口径维持双轨但**按域钉死用途**）。

## 3. DESIGN

### 3.1 P0（新增，最高优先）：thinking 签名全链路回传修复

**用户裁决**：pi 有回传机制而 x-harness 丢弃了它——这是 bug，必须修。reasoning
签名（openai = `reasoning_details` 加密项 / anthropic = thinking `signature`）是
多轮工具调用中模型推理连续性的必要载荷（pi 对同模型自动回放），丢弃导致每轮
推理链断裂 + 网关侧只能靠会话缓存自行补救（§7.1 归因的缺口源头）。

**丢失点定位**（两处，全链路其余环节 pi 已支持）：
1. `packages/llm/src/pi-events.ts`：`thinking_end` 事件 → 只映射文本 delta，
   `partial.content[i].thinkingSignature` 丢弃；
2. `packages/llm/src/pi-context.ts` `assistantContent()`：只整形 text/toolCall，
   thinking 块不重建。

**修复（五层通道，每层一个判别点）**：

| 层 | 改动 | 载荷 |
|---|---|---|
| L1 chunk | `LlmChunk` 新增 `thinking-end`（或 thinking-delta 携可选 signature）：
   pi-events 的 `thinking_end` 映射时从 `partial` 取签名随块发出 | 签名原文 |
| L2 累积 | `StreamAccumulator` 捕获签名（与 thinkingText 同步累积） | 进程内 |
| L3 WAL | `assistant/message`/`assistant/attempt` 的旁路字段扩形（对抗审查 B-2/
   B-3 按处置后规格重写）：
   - `thinking?: string`（既有）
   - `thinkingBlocks?: Array<{ signature: string; redacted: boolean; origin: { provider: string; model: string } }>`
     ——块级数组（多 thinking 块各自独立签名，H2），redacted 标志随块（回放形态
     redacted_thinking），origin = 落账时实际路由（H1 provenance——从 request/
     context 事实折叠，非当前拨号）；
   - gates 词表：`thinkingBlocks` 在场必须是合法数组（每项 signature 非空 string、
     redacted 布尔、origin 形状齐全）；缺席省略，旧档案零迁移；
   - **fork/子代理种子**（B-2）：`agent-delegation/lineage.ts` 的
     `assistantRecastData` 同步携带 thinkingBlocks——否则每个子代理的推理连续性
     修复落空；包清单加 agent-delegation | 持久 |
| L4 投影 | `surfaceToMessages` 的 assistant 分支携带 thinkingBlocks（含 origin）
   纯透传——**provenance 关联在 L3 落账时完成**（对抗审查 M-2 规格：attempt/
   settle 落账处从 events 反扫最近 request/context 取实际路由，O(该步增量) 而非
   每投影全折——落账时刻的路由事实唯一且已定）；SurfaceMessage 扩可选字段 | |
| L5 wire | `toPiMessages` 的 `assistantContent()` 重建 `ThinkingContent` 块——
   **仅 openai 协议**（B-1 裁决：anthropic 跳过）；重建门（H1/H2/B-3 同步）：
   ① origin 比对当前路由，不匹配不重建（防路由 meta 伪造使 pi 跨模型门失效）；
   ② 块序 prepend；③ 多块按 thinkingBlocks 数组逐块、redacted 随块；
   ④ **完整性门（H-3）**：`interrupted: true` 的消息签名按半截处理——settle 时
   未见 thinking_end 的块不落签名（L1/L2 只在 end 帧发签名，中断路径自然不落，
   该不变量写入 L1 实现契约）；⑤ provenance 缺席（旧档/script adapter）默认
   **不重建**（fail-closed，宁缺勿错） | |

**与 STREAM-PARTIAL-PERSISTENCE 裁决的关系（对抗审查 B-1 按协议分立裁决）**：
- **openai 路径**：回传的只是 `reasoning_details` 加密项（不透明 blob，不含明文
  思考）——「thinking 文本不进 wire」在 openai 侧严格成立，非目标不动；
- **anthropic 路径**：pi 的同模型回放发的是**整块**（thinking 文本 + signature——
  anthropic 签名的校验对象是原文，空文本 + 签名形态 pi 客户端容忍但服务端行为
  未实证）。裁决：**anthropic 维持现状不回传**（L5 的 provenance 门对
  anthropic-messages 协议直接跳过重建），待真端点冒烟实证「空文本+签名」可行后
  再放开（届时需同步改非目标、c_text 系数与 STREAM-PARTIAL-PERSISTENCE 的回传
  半项——三处一改，不在本件赌未实证行为）。S0 验收装置因此**必须含真端点冒烟**
  （mock 适配器测不出服务端签名校验行为）。

**占用口径联动（§3.1 后半全部重写的原因）**：回传修复后 thinking 签名成为 wire
的实打实构成（openai 加密项按字符计费），「估算域含 thinking」从「对网关行为的
防御」升级为「对自身 wire 的如实测量」——量级上加密项比明文 thinking 小得多
（压缩 blob），但 §7.1 观察到的八成缺口本就可能是网关回注的明文——修复后
网关无需再自行回注，缺口应显著收窄。§3.1 的 estimateContextTokens 设计不变，
但其「thinking 项」按 §3.1b 的双 regime 常数计（legacy 0.8 / post-S0 按签名与
文本分列，B1 处置后的唯一口径——本段旧 0.5 表述作废）。

**验收**：3 步工具调用会话（openai + anthropic 各一）——第 2/3 步 wire 断言
`reasoning_details`/thinking 块在场；WAL 断言 thinkingSignature 落盘；resume 后
第 3 步仍回传。症状回归名：「多轮工具调用的 reasoning 签名丢失」。
**LlmChunk 扩形的连锁回归面**（对抗审查 M7，S0 验收必列）：StreamAccumulator
switch（stream.ts:21-51）、attempt 流帧（attempt.ts:184）、llm-replay-guard 的
hasContent 口径（thinking 不算 content，语义维持）、以及全部 chunk.type 下游
switch 的穷尽性测试。

### 3.1b P1+P2 根治：统一「计费域」测量

**新原语与包归属（对抗审查 H-1 裁决）**：`estimateContextTokens` 及节点估算面
（nodeTokens/estimateBlocks/IMAGE_TOKENS——自 compaction 下移）迁入 token-meter
（token-meter 的 deps 只有 core+session，节点估算不反向依赖 compaction，环解除；
compaction 改 import token-meter 的节点面，唯一真相）。签名：

```ts
/** 会话上下文占用（计费域）：投影节点（上界口径）+ thinking 载荷（签名 + 防御余量）
 *  + wire 膨胀系数。与切口预算同尺——findCutPoint/l1 收益/watermark 消费同一数值域。 */
export function estimateContextTokens(nodes: readonly SurfaceNode[], events: readonly SessionEvent[]): number;
```

原语主体（消费方切换清单见下）：

实现（投影一次遍历；**提取纪律是契约的一部分**——对抗审查 B3：events 是 journal
永不改写，从 events 侧读 thinking 会在每次 replace 后留下永久幽灵占用，复活
occupancy.ts 文件头已修过的同类 bug）：
- `Σ nodeTokens(node)` + `Σ messageThinking(node)`——**message 侧 thinking/签名只从
  `nodes`（投影过滤后）取**：节点携带（S0 的 L4 让 surfaceToMessages 透传，estimate
  同源），replace 摘除即消失；
- attempt 侧**不计**（§7.2 裁决：log-only 词条永不进 wire，thinking 不属占用域——
  其计费归 meter 实报；潜在网关回注并入系数校准余量，不单列）；
- `+ Σ thinkingPayload`——**两个 regime、两套常数**（对抗审查 B1 修正：单一 0.5
  过不了本方案自己立的验收门——复算 366k + 0.5×464k + 40×2255 ≈ 688k < liveBudget
  805k，L2 仍卡死；系数必须 ≥ 对账观测值）：
  - thinkingSignature 在场（post-S0 档案）：`estimateText(signature)`（wire 实构成，
    系数 1）+ `c_text × estimateText(thinking)`；
  - 无签名（pre-S0 legacy 档案，网关回注 regime）：`c_legacy × estimateText(thinking)`，
    初始 0.8（§1.1 对账观测：缺口 379k ≈ 464k×82%）；
  - 系数由 S1 对账夹具分 regime 校准（legacy 档案定 c_legacy、post-S0 会话定
    c_text）；两 regime 不得混用同一常数（M3）；
- `+ wireOverhead(nodes.length)`：`+ 40/节点`（role 头 + JSON 信封）。挂载点
  （对抗审查 L-2 明确）：token-meter 自身的 Options（估算原语的装配参数，
  不进 CompactionOptions/GateConfig——消费方经原语默认值取用）。不乘全局
  1.26 系数（节点级开销按经验值折入；CJK 上界已含保守余量）。

**消费方切换**（全部改读 `estimateContextTokens`，删各自的测量）：
- `measureContext`（compaction/occupancy.ts）→ 锚机制保留（实报锚校准尾估），但
  **尾部估算改用计费域**：锚后节点的 nodeTokens + 其 thinking + wire 开销；
- `autocompact/gate.ts` 的 `measureOccupancy` → 同上（复用 compaction 的 measureContext，
  两包测量合一——现状已是复用关系，改一处即全动）；
- `l1PreGateWorth` / L1 收益（`scavenger.computeClearPlan`）→ 收益 = 清理词条的
  nodeTokens（不变——tool/result 无 thinking，天然同域）；
- `escalateL2` 的 liveBudget → **分母不变（l2Line）但切点判定域已统一**：thinking 计入
  占用后，投影域数值 = 计费域数值，`findCutPoint` 的「全在保留预算内」不再假性成立。

**thinking 的切口语义**（关键裁决，随 P0 修复更新）：L2/92% 的摘要区间替换掉
一段投影节点时，区间内 assistant 消息的 thinking 及其签名随之淘汰——被摘要的
轮次不再需要推理连续性（模型看摘要续作），与新前缀的缓存重建同步。因此：
- `escalateL2` 与 `runCompact` 的区间收益按「节点 tokens + 关联 thinking」计（新函数
  `spanContextTokens(nodes, events)`，与 estimateContextTokens 同尺；签名随所属
  节点一起被摘要区间替换（L3/L4/L5 同步淘汰——替换后新 wire 不再携带）；
- CP 段门槛（`checkpointMinSegmentTokens`）同尺。

**不换尺的面及理由**（审查 B 建议)：`pendingClaimTokens`（领取未落账批次——
实报域数字）、CP 的 `boxSegment` 装箱（字符域硬界，与 token 估算无换算关系）、
summarize 的输入预算（字符域同上）——三者本就不在「投影估算 vs 实报」的脱节
面上，维持原口径。

**基底项不在原语内**（对抗审查 M6 落档）：system prompt/tools 基底（实测 ~11.5k，
占比 1.4%）无干净的注入位（原语只看会话投影）——由实报锚自然吸收（锚的
usage.input 含基底），纯估算路径（无锚冷启动）接受该低估，量级入 S1 对账门。

**归因链 contingency（对抗审查 M-4）**：c_legacy=0.8 的定值依赖「缺口=网关回注」
为真。B1 复算（0.8 → 828k > 805k）是**回归锁**（拿对账观测定系数，锁症状不复
现），不是机制验证。若 S0 抓包否定归因（缺口实为 wire 包装/schema 漂移）：
S1 的 regime 结构降级为单常数重校（结构不变、常数重定）；S2 的 L2 修复不受影响
（同尺化本身消解「投影域 < 计费域」的脱节，与缺口来源无关）。±15% 对账门失败
时的处置路径：先重定源（抓包复核）再放宽门——禁止直接放宽。

**为什么选「扩估算域」而不是「改锚定」**：占用锚（usage 实报）是最准的信号，
三家参照系都以它为主。但实报只能事后看到——切口必须在落账前算得出「这一刀能省多少」。
扩估算域让两域同尺后，锚仍用于校准（trailingFactor 机制不变），实报与估算的偏差
收敛到单一系数（wire 系数），不再有 38 万的系统性黑洞。

### 3.2 P3：折叠归一（get_session_stats 消费 meter）

- `host-hub/worker-read-commands.ts` 删 `foldStats`/本地 `foldUsage`，改消费
  token-meter。装配路径（对抗审查 M4 修正 + B 审 L-3 再修正：原表述「host-hub
  不 import 插件包」不实——assembly.ts 直接 import @x-harness/compaction 等；
  取简：worker-read-commands 直接 import tokenMeter service token（与 kit 插件
  同为 @x-harness/* 包依赖，无需绕道按名注册表）；实施时若遇循环依赖再退
  按名注册表方案）；
- 映射：`tokens.input = inputTokens`、`output = outputTokens`、
  `total = totalTokens`（= input+output，缓存子集不加计）；
- **cost 面（对抗审查 H3）**：现行 foldStats 透传 `usage.cost.total` 而 meter 的
  SessionUsage 无 cost 字段——处置：meter 扩 `costTotal` 桶（成本归因是计量事实，
  parseUsageSample 同步收编），get_session_stats 照常透传；不做「静默删字段」；
- **undefined 降级（H3 续）**：meter 对未知/溢出会话返回 undefined——命令面
  显式契约：undefined → 全零 tokens 形态（与 analytics 的降级同律），不 500；
- `assistant/attempt` 计入（与 meter 一致——失败尝试计费是 TOKEN-METER.md §1 既有裁决）；
- 计数面（userMessages/toolCalls 等）保留本地扫 WAL（纯计数非 token 域，无口径问题）。

### 3.3 P4：servedWindow 落账装配

- `agent-loop/step.ts` 的 `appendEvent("request/context", …)` 补
  `contextWindow: dial.contextWindow`（Dial 现无该字段——`tokens.ts` 的 Dial 形状扩
  `contextWindow?: number`，装配侧（hub dial-hook / llm 适配器）从
  `llmRuntime.contextWindowOf(provider, model)` 回查注入；缺省不落字段——
  `lastWindow` 对缺字段词条仍 undefined，分母回落主窗，行为与现状一致）；
- 413 自愈路径已写该字段（COMPACTION.md §1.1 既有），本项是把常规拨号也落上；
- `lastWindow` 读取逻辑不变（末词条定线路事实）；
- **隐含不变量显式化（对抗审查 M-6）**：自愈缩窗的持久性依赖「provider+model
  位移才落 request/context」——路由往返切换（换模型再换回）会覆盖自愈值（回到
  目录窗，方向安全）；该不变量写成 S4 测试（拨号→413 缩窗→不位移的后续步不
  覆盖缩窗值），不靠巧合。

### 3.4 P5：UI 压缩摘要呈现（agent-app 侧）

**本仓既有范式优先**（不引入新交互模式，复用三套现成构件）：

1. **信封帧谓词范式**（`packages/api/src/views/snapshot-frame.ts`）：内核把「模型
   上下文非对话内容」的 user/message 以结构谓词识别、渲染面整帧降级——压缩摘要
   是同一性质（模型上下文的重述，非用户发言），沿用该思想但**不整帧跳过**（摘要
   对用户有归档价值，快照帧没有）。
2. **轮次状态行折叠范式**（`turn-status-line.tsx` + `useTurnCollapse` +
   `ChevronToggle`）：「纯文字标签 + 展开箭头 + 点击开合」是本仓过程折叠的唯一
   交互词汇——压缩标记行复用同一形态，不造新组件语言。
3. **系统注入通道**（`origin: 'system'` → `SystemMessageRow`）：mapEntries 已把
   replace 型摘要归入 system 通道——通道保留，行内形态分化。

**契约**：判据住 `packages/api`（协议字段谓词，与 snapshot-frame 同居所）：

```ts
// packages/api/src/views/compaction-summary.ts（新文件，单一职责）
/** 压缩摘要帧判别（compaction 全触发面 + autocompact L2 的 replace 型落账）：
 *  user/message ∧ surfaceOp=replace ∧ 单 text 块 ∧（尾注在场 ∨ manual 来源）。
 *  append 型用户消息永不命中。对抗审查 H4：manual /compact 不附加尾注
 *  （compact.ts:283 trigger==="manual" 时空串）——纯尾注谓词会漏判手动压缩；
 *  manual 来源以「replace 型 + 无尾注 + 文本以 SUMMARIZATION 结构特征开头」
 *  三重弱判据识别，或接受 manual 摘要维持现状并写入不处理清单（实施时二选一，
 *  禁止静默漏判）。与 snapshot-frame 同构的跨包协议镜像，常量与上游
 *  AUTO_CONTINUATION_NOTE 对齐（锁测试）。 */
export function isCompactionSummary(event: Record<string, unknown>): boolean;
```

HistoryItem **不扩判别形状**：`kind` 判别值不变（可选 meta 字段不破坏 discriminated
union——对抗审查 L1 措辞修正）；转写/水化/去重链路零改动，渲染层经 mapEntries
命中的推导标记识别（见下）。

> 标记传递二选一（实施时定，倾向 A）：
> A. `HistoryItem` 扩可选 `meta?: 'compaction-summary'`（discriminated union 不破坏，
>    可选字段向后兼容，contracts 锁测试同步）；
> B. 渲染层在 `message-list` 前置推导（id → text 尾注嗅探——违背「不在组件嗅探
>    文本」纪律，仅作备选）。

**渲染**（`message-list.tsx` 的 system 分支分化，新组件一个文件一事）：

- `CompactionSummaryRow`（新）：默认单行标记「已压缩前 N 轮对话」+ `ChevronToggle`
  （与 TurnStatusLine 同形态词汇，不放卡框）；点击展开后以 `TextBlock`（Markdown）
  呈现摘要正文；N 取 mapEntries 的 applySurfaceOp **splice 计数**（对抗审查 M1：
  endSeq − startSeq 不是条目数——迭代前缀替换后头部节点携带 journal 尾 seq，
  端点差非连续可倒挂），随标记携带。
- `SystemMessageRow` 维持现状（task-notification 等运行时注入的居中卡）——两类
  系统消息形态分化：注入是事件、压缩是断代，视觉不应同形。
- 文案进 `strings/zh.ts`（`flow.compactionSummaryLabel` 等），禁止硬编码。

**live 面**：压缩落账经 `compaction/landed` → `compacted` UiEvent → fold 已把
`compacting` 归位（横幅消失）——摘要条目经轮末 rebuild 从转写到达，无需 live 事件
通路（现状已如此，无改动）。

**既有数据兼容**：历史会话的 replace 型摘要靠同一条谓词识别（surfaceOp.replace ∧
尾注）——老档案无需迁移；尾注常量复制进 `packages/api` 并加锁测试与上游
AUTO_CONTINUATION_NOTE 对齐（app 侧不依赖 x-harness 的既有纪律）。

### 3.5 口径用途钉死（文档契约，随本件写入 TOKEN-METER.md）

| 函数 | 口径 | 唯一用途 | 禁用面 |
|---|---|---|---|
| `estimateText` | 上界（CJK 1.25） | 压缩/预算/占用（**新增 thinking 估与 wire 开销也用此**） | 显示面 |
| `estimateTokensTypical` | 典型值（CJK 1） | analytics 分项显示 | 一切预算判定 |
| `estimateContextTokens` | 计费域（上界+thinking+wire） | 占用判定/切口/收益 | 显示面 |

## 4. 实施切片（每片独立可合，四门全绿 + 回归用例随片）

| 序 | 切片 | 包 | 验收要点 |
|---|---|---|---|
| S0 | **P0 thinking 签名五层通道**（chunk→累积→WAL→投影→wire）+ gates 词表 + fork 种子（B-2）| llm + agent-loop + core/session + agent-delegation + host-hub + agent-app(contracts) | 症状回归「多轮工具调用 reasoning 签名丢失」：openai 3 步会话 wire 断言 reasoning_details 在场（anthropic 按 B-1 裁决不回传——真端点冒烟单列）；resume 后仍回传。**hub wire 面（H-2）**：新 chunk 类型会经 tapLlmStream 直推 app——L1 的签名 chunk 在 tap 处**剥除**（签名 blob 不进 UI 流，纯噪音），agent-app contracts 的 LlmChunk 镜像与 event-mapper 不需要新分支（剥除后形状不变）；**get_messages 读口（H-4）**：deriveMessages 携签名后软上限回归用例（或裁决该读口剥离签名——实施时按 UI 是否消费 thinkingBlocks 定） |
| S1 | `estimateContextTokens` + `spanContextTokens` 新原语 + 单测 | token-meter | 计费域含签名+防御余量+wire；与实报锚对账用例（真实 WAL 夹具：851k vs 估算 ∈ ±15%） |
| S2 | measureContext/gate/escalator/compact 切换计费域 + L2/92%/CP 段门槛同尺 | compaction + autocompact | 症状回归：s5qad7 快照（85% 时刻）L2 必须落账；l1-no-progress/l2-no-progress 场景测试（观测面：autocompactDiagnostic 事件总线面——非仅 stderr，B 审 L-5） |
| S3 | foldStats 删除 → meter 消费 | host-hub | get_session_stats 与 get_token_analytics 数字一致性测试 |
| S4 | request/context 落 contextWindow | agent-loop + llm | WAL 断言新字段；lastWindow 读取生效 |
| S5 | UI 压缩摘要折叠呈现 | contracts + api + electron renderer | 症状回归「92% 摘要整卡显示」：bw 真机走查（真实 WAL 预置 → 断言标记行 + 展开态） |
| S6 | keepMinTurns 轮次下限护栏 + 发送层配对兜底 + settings 配置面 | compaction + autocompact + llm + hub | 组合保留用例（大工具轮场景保 ≥5 完整轮）；悬空 tool_use 兜底用例；settings 覆盖链路 |

S0 独立先行（bug 修复，不依赖其余切片且改变它们的基线）；S1→S2 是一个语义整体
（新尺 + 换尺，在 S0 之后做保证对账系数干净）；S3/S4/S5 独立并行；S6 依赖 S2 的
同尺域（轮次计数的 token 上限保护需要新尺），可与其余并行开发、S2 合入后落地。

## 5. 测试与验收

- **对账夹具**：s5qad7 三个时点（22:12 / 85% / 末态）作为 `__test__/fixtures`
  快照——计费域估算 vs 实报偏差 ≤ ±15%（wire 系数经验值的不确定度）；
  **regime 标注**（B 审 L-4）：夹具按会话起点纪元归 regime（pre-S0 起点 =
  legacy 系数、post-S0 起点 = 签名系数；混合档案以首条 thinkingSignature 在场性
  判定纪元），post-S0 会话另行采集（S0 合入后跑真实会话取三时点）；
- **症状回归**（每条一个用例，名注明症状）：
  0. 「多轮工具调用的 reasoning 签名丢失」：双协议 3 步会话 wire 断言（S0）；
  1. 「85% 越 L2 零落账」：thinking 重会话夹具 → L2 必须产 replace 落账；
  2. 「L1 清后占用不降」：thinking 占主导夹具 → L1 收益核算后预门槛如实拒绝（不再烧缓存重写）；
  3. 「92% 摘要 UI 整卡显示」：mapEntries + 渲染两层断言折叠形态；
  4. 「get_session_stats 漏 attempt」：attempt 计费夹具两读口数字一致；
  5. 「大工具轮吃光预算只保 0-2 轮」：末轮 27k 工具轮夹具（1M 窗）→ 组合判定保
    ≥5 完整轮（轮首对齐不变；小窗 25% 硬帽下的合法降轮另测——L-1 对齐）；
  6. 「悬空 tool_use 发送」：构造孤儿对（截断边界形态）→ 发送层兜底校验拦截；
- **e2e**：夜间门补「长会话压缩旅程」（mock 模型注入 thinking 流 → 四线依次触发 →
  UI 三态：正常流/标记行/展开）；
- 覆盖率：新原语与切换路径行覆盖 ≥ 90%（仓库门禁标准）。

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| wire 系数经验值偏差 → 过早/过晚触发 | S1 对账夹具锁定 ±15%；线位百分比不动（拓扑既有裁决），偏移只影响时机不影响失效 |
| thinking 进切口域后误切「在飞轮」思考 | 沿用既有护栏（isTurnStartNode 对齐 + 在飞轮整轮豁免）——thinking 跟随所属 assistant 节点，无独立切口角色 |
| provider 缓存对 reasoning 的保留行为不明 | 切口收益按「落账后不再发送」计（乐观）；若 provider 仍保留，实报锚自动校准尾估（trailingFactor）——无双重计数 |
| UI 折叠判据对老档案误判（用户手写同尾注文本） | append 型用户消息永不命中（surfaceOp 判别）；manual 无尾注面按 H4 裁决的弱判据或显式不处理清单（与 §3.4 同步——非「尾注必须在场」） |
| S2 切换后行为面变化大 | 独立切片 + 真实 WAL 回放测试（全量 sessions 目录跑 projectSurface+新尺，无异常数值告警）作为合入门禁 |

## 7. 开放问题裁决（讨论已定）

### 7.1 thinking 计费机制——代码级已排除，网关行为待 S0 抓包实证（对抗审查 M2 收敛措辞）

深挖 pi 源码（/Users/wrr/work/pi）后的完整链路：

**pi 的 reasoning 回放机制存在但 x-harness 丢弃了入口**（→ §3.1 P0 判定为 bug，修复而非适配）：
- pi `openai-completions.ts` 确有回放通道：流式响应里的 `reasoning_details` delta →
  `ensureThinkingBlock("")` 存进 `thinkingSignature`；下一轮请求时若 assistant 消息带
  thinking 块，`transformMessages` 对同模型把 `preservedReasoningDetails` 写回
  `assistantMsg.reasoning_details`（wire 上回传，计入 input）。
- **但 x-harness 的消息面永远没有 thinking 块**（已实证：`toPiMessages` 对真实 WAL 的
  assistant 消息输出 `[text, toolCall]`，thinking 顶层字段不进 content；
  `surfaceToMessages` 投影亦白名单排除）→ `preservedReasoningDetails` 恒 undefined →
  wire 恒无 reasoning_details 字段。
- 结论：**x-harness 丢弃签名是链路断点（bug），网关侧回注是缺签名时的替代路径**。
  修复（P0）后：签名正规回传，网关无需自行回注——占用缺口的主体转为自身 wire 的
  签名载荷（可测、可切、随压缩淘汰）。

**对方案的影响（裁决）**：
1. 用户裁决「pi 能传给 LLM 就必须回传」——修复为 P0 切片（§3.1 五层通道），
   不再是「按事实设计」的适配姿态。
2. 占用估算域含 thinking 载荷的设计不变，但语义升级：修复前是对网关回注的
   防御性测量，修复后是自身 wire 的如实测量（签名实构成）+ 防御余量（c_text/
   c_legacy 双 regime 系数，S1 对账夹具分 regime 校准——见 §3.1b）。
3. wire 抓包实验并入 S0 验收（修复前后各抓一次，量化网关回注行为的变化）。

### 7.2 attempt 的 thinking 计入占用——裁决：**不计**（对抗审查 H5 修正原裁决）

原裁决「计入（含签名）」与 §7.1「修复后是自身 wire 的如实测量」自相矛盾：attempt
是 log-only 词条、永不进 surface 投影（surface.ts SURFACE_TYPES 不含 attempt），
其 thinking/签名**永远不会出现在后续请求的 wire 上**——不属于「自身 wire」域。
「网关不区分成败」是对回注行为的猜测，把它固化成占用常驻项在 post-S0 后是纯高估。
修正裁决：
- attempt 的 token 计费归 meter（现状正确，含 thinking 无关的 usage 实报）；
- **占用域不计 attempt 的 thinking**；网关对失败尝试的潜在回注并入 c_legacy/
  c_text 系数的校准余量（S1 对账夹具一并吸收），不单列确定项；
- attempt 的 thinkingSignature 落盘（S0 的 L3）仍然要——档案完整性，与占用无关。

### 7.3 92% keep 语义：纯 token 保留 → **token 主语义 + 轮次下限护栏（组合，可配置）**

**三家参照的处理方式**：

| 参照 | 保留语义 | 配置面 |
|---|---|---|
| claude-code | **API 轮次分组**（`groupMessagesByApiRound`：assistant-id 边界分组，
  413 自愈时按组数丢弃 `max(1, groups×20%)`）；配对完整性不靠切口靠**下游修复**
  （`ensureToolResultPairing`：发送前剥离孤儿 tool_result、补占位 user、去重
  tool_use——压缩创造的任何残缺都在 API 层兜底） | 无用户配置（内部常量） |
| codex | **整体替换 + 用户原话回填**：压缩后历史 = 摘要 + 从尾向头选用户消息至
  `COMPACT_USER_MESSAGE_MAX_TOKENS=20k`；孤儿输出由 `remove_orphan_outputs`
  （normalize 层）静默剥离；触发线 = 模型目录 `auto_compact_token_limit`（缺省
  `contextWindow×9/10`，模型级可配） | 模型目录内置（非用户级） |
| kimi-code | **双约束轮次保留**：`maxRecentMessages: 4` + `maxRecentUserMessages:
  ∞` + `maxRecentSizeRatio: 0.2`（三个上限任一触达即停，取满足配对约束的最后
  可切点）；**配对完整性在切口层硬保证**——`canSplitAfter` 五重谓词：不在 user 后切、
  不在带 toolCalls 的 assistant 后切、不在 tool 结果后切、前缀不得结束于未闭合
  tool 交换（`prefixEndsWithOpenToolExchange` 反向扫描配对计数） | 代码内常量（未暴露用户配置） |

**真实数据驱动的选型**（68 个本机真实会话重放，62 主 + 6 子代理；只看主会话结论不变）：

- 现状纯 20k 的问题量化：用【真实 findCutPoint】跑 56 个可切主会话，
  **保 ≤2 轮占 70%**（节点粒度攒预算 + 向下对齐轮首会再吃掉轮——轮粒度模拟
  为 62-63%，真实更糟）；轮粒度分布 p10=0 / 中位 2 / p90=5；
- 受益面：末 5 轮含大工具轮（>15k）的会话占 **71%**（42 个 ≥5 轮主会话）——
  大工具轮（读文件/grep）一拳吃掉预算，最近工具现场被摘要；
- 组合方案保留量：p50 43k / p95 109k / max 233k（1M 窗下最坏 23%，不失控）；
- **maxN（轮数上限）被证明冗余**：纯 20k 预算天然封顶（真实数据保轮数 max=9，
  min5+max8 与 min5+max12 保留量分布一字不差）——不引入；
- 时间稳定性：按天分桶（09-21→09-26）保≤2轮比例 53%-71%，无趋势漂移。

**裁决（token 主语义 + 轮次下限护栏，两参数组合）**：

```ts
// 保留区判定（findCutPoint 增量改造，从尾向头扫描、轮首对齐落刀不变）：
//   预算停：累计 > keepRecentTokens(20k，主语义不变) 且 已保 ≥ keepMinTurns(5)
//   下限兜底：不足 5 轮时无视预算继续保（大工具轮场景——近期工具现场不丢）
//   上限：不设——预算天然封顶（实测 max 9 轮）
//
// 对抗审查 B2 的三条让位规则（minTurns 是 best-effort 下限，不是硬约束）：
//   ① emergency 豁免：trigger=emergency 时 minTurns 无效（keep=0 语义纯净——
//      cut.ts:10 明文「配额放大保留区会导致自愈重试后仍超窗」，413 自愈不得被放大）；
//   ② 切口存在性优先：扫描触达 protectedHead 仍不足 minTurns 时，回退纯预算切点
//      （宁可少保轮，不得把「有切口」变「无切口」——否则复刻 l2-no-progress 停摆）；
//   ③ 小窗硬顶：minTurns 兜底保底量不得超过 effectiveWindow × 25%（小窗模型上
//      5 轮 × p95 47k 早已越窗；超顶即降轮数）。
```

1. **`keepRecentTokens=20k` 维持主语义**（压缩目标直接对应「释放多少」，与
  现有代码零语义变更）；
2. **`keepMinTurns=5` 新增下限护栏**（用户提议，数据背书：受益面 71%）：
  findCutPoint 循环加一条「攒够但不足 minTurns 时继续」；5 轮中位 43k。护栏是
  best-effort：emergency 豁免、切口存在性优先、25% 窗硬顶三条让位规则（见上）
  兜住小窗与自愈路径（对抗审查 B2）；
3. **配对完整性三重防线**（本仓已有前两层，补第三层）：
  - 切口层：`isTurnStartNode` 对齐（现有，构造保证——user/message 永不在
    tool_use 与其 result 之间，不拆工具对）；
  - 落账层：replace 区间完整性（现有，surface 位置区间语义）；
  - **新增发送层兜底**：`toPiMessages` 后校验首个 assistant 消息无悬空
    tool_use、首个 tool result 有对应 tool_use（对齐 claude 的
    ensureToolResultPairing 思想但本仓只需薄校验——前两层已把概率压到 resume
    /截断边界，此处只兜底不修复）；
4. **配置面（两家都未做的补充；对抗审查 M-5 补全消费方）**：`CompactionOptions
  .keepMinTurns`（装配注入，缺省 5）+ `hub settings` 键 `compaction.keepMinTurns`
  （用户级覆盖——HubSettings 接口 / validateSettingValue / isKnownKey / agent-app
  contracts 镜像四处同步）；`keepRecentTokens` 同步暴露配置时**点名收编
  `COMPACT_KEEP_RECENT_TOKENS`**（command-compact.ts:21 独立硬编码，manual /compact
  的 keep 不走 CompactionOptions——不收编则手动/自动两路口径分叉）；**运行语义
  声明**：worker 装配期快照读设置，改设置需 worker 重启（或下轮 resume）生效——
  非热更，写入文档不隐瞒。

**方法论声明（数据局限如实入档）**：压缩时刻取会话末端近似（非逐会话回放真实
92% 触发点）——对轮形态分布问题呈合理近似；组合保留量来自轮粒度模拟，
精确值以 S6 实施对账为准；重放样本为主会话（子代理会话的压缩窗口错配是既有
问题——autocompact 对 agentId 会话按主拨号 contextWindow 建线，子代理模型覆盖
时四线全偏，S2 换尺后 thinking 计入会放大偏差，入「不处理清单」：修复需 per-
session 窗口解析，独立成件）。

**不处理清单（本件明确不做）**：子代理会话的压缩窗口错配（上述）；anthropic
thinking 整块回传（B-1 裁决待实证）；app live 面压缩摘要的实时事件通路（现状
经轮末 rebuild 到达，够用）。


## 8. 对抗审查处置记录

### 审查 A（技术正确性，agent-5dc1e9db）——已全部处置

| 级别 | 发现 | 处置 |
|---|---|---|
| B1 | thinking 系数 0.5 过不了自立的验收门（复算 688k < 805k，L2 仍卡死） | **接受**：改双 regime 常数（legacy 0.8 / post-S0 按签名+文本分列），§3.1b 重写；复算验证 0.8 时估算 828k > 805k 切口存在 |
| B2 | keepMinTurns 破坏 emergency 纯净性 + 可造成无切口停摆 | **接受**：三条让位规则（emergency 豁免 / 切口存在性优先回退 / 25% 窗硬顶）写入 §7.3 伪代码 |
| B3 | events 侧 thinking 提取在 replace 后留永久幽灵（复活已修 bug） | **接受**：提取纪律进契约——message 侧只从 nodes 取、attempt 不计（连带 H5） |
| H1 | toPiMessages 伪造路由 meta 使 pi 跨模型签名门恒真（400 风险） | **接受**：L4 投影携带落账时实际 provider/model，L5 重建前比对（provenance 门） |
| H2 | 单 string 签名表达不了多块/redacted 形态 | **接受**：L3 数组形态 + redacted 布尔，L5 按块重建 + prepend 块序 |
| H3 | meter 无 cost 字段 + undefined 无降级 | **接受**：meter 扩 costTotal 桶；undefined → 全零形态显式契约 |
| H4 | manual /compact 无尾注 → 谓词漏判 | **接受**：判据放宽（尾注 ∨ manual 弱判据），实施时二选一不得静默漏判 |
| H5 | §7.2 attempt 计入与 §7.1 wire 如实测量自相矛盾 | **接受**：撤回原裁决，attempt thinking 不计占用（归系数余量） |
| M1-M7, L1-L2 | splice 计数 / 措辞收敛 / 装配路径 / 基底落档 / 连锁回归面 / 自相矛盾 | **全部接受**：逐处修改（见各节「对抗审查 Mx」标注） |

审查 A 验证确认无误的关键面（其校准清单 1-14）与本方案实施前提一致：pi 通道
可行性（含 anthropic 一次 end 取全签名）、P1 机制链、五层落点、P3/P4/P5 事实。

### 审查 B（完整性与逻辑，agent-cbeb4409）——已全部处置

| 级别 | 发现 | 处置 |
|---|---|---|
| B-1 | thinking 文本是否上 wire 前后矛盾；anthropic 空文本+签名形态未实证 | **接受，按协议分立**：openai 只回传加密项（非目标严格成立）；anthropic 维持不回传待真端点实证（三处联动改档后放开）；S0 验收装置加真端点冒烟 |
| B-2 | fork/子代理种子（assistantRecastData）丢签名，子代理修复落空 | **接受**：L3 落账携 thinkingBlocks + lineage 重铸同步携带；S0 包清单加 agent-delegation |
| B-3 | §3.1 五层表与 §8 处置不同步（按正文实施会做出被否决形态） | **接受**：L3/L4/L5 按处置后规格整体重写（thinkingBlocks 数组 + redacted + origin + gates 形状门） |
| H-1 | nodeTokens 在 compaction、estimateContextTokens 在 token-meter，依赖成环 | **接受**：节点估算面下移 token-meter（nodeTokens/estimateBlocks/IMAGE_TOKENS），compaction 改 import——环解除、单一真相 |
| H-2 | 新 chunk 类型经 tapLlmStream 直推 app，契约面无处置；签名 blob 是 UI 噪音 | **接受**：L1 签名 chunk 在 tap 处剥除（UI 流形状不变），agent-app contracts 零改动；S0 包清单加 host-hub |
| H-3 | 中断流的半截签名回放 → 坏签名 400 | **接受**：L1 只在 thinking_end 发签名（中断路径自然不落）写入实现契约；L5 加完整性门 |
| H-4 | get_messages 软上限被签名膨胀顶穿 | **接受**：S0 验收列该读口回归（或裁决读口剥签名，按 UI 是否消费定） |
| M-1..M-7 | 0.5 残留 / provenance 机制 / 风险表矛盾 / 归因 contingency / S6 配置消费方 / S4 不变量 / 子代理窗口错配 | **全部接受**：逐处修改（M-2 provenance 落账时钉入、M-4 区分回归锁与机制验证+失败处置路径、M-5 收编 COMPACT_KEEP_RECENT_TOKENS+重启语义、M-7 入不处理清单） |
| L-1..L-5 | 用例措辞 / wireOverhead 挂载点 / M4 前提不实 / 混合档案纪元 / 观测面 | **全部接受**：逐处修改（L-3 再修正为直接 import tokenMeter） |

审查 B 确认完整的面（其清单）：S2 换尺消费方无遗漏（并建议补「pendingClaim/
boxSegment/summarize 为何不换尺」说明——采纳，见 §3.1b 尾注）、P3/P4/P5 事实链、
S0 断点定位、参照系引用准确性、回滚安全性（旧 gates 对未知键不拒）、跨切片依赖
无循环（除 H-1 已裁决解除）。

### §7.4 阈值定稿（实施随 S6 后追加——真实数据重放 + 三家准则合成）

三家参照准则：claude = 绝对余量（有效窗−20k−13k，200k 窗 ≈83.5% / 1M ≈96.7%）；
codex = 90% 恒百分比 + 模型目录覆盖；kimi = 85% + 保留双约束。共同点：单线。
本仓四线分层按各层职责分别定线（数据实证见下）。

| 参数 | 1M | 512k | 256k | 准则 |
|---|---|---|---|---|
| CP 检查点 | 30% | 35% | 40% | CP 越早越省（s5qad7 重放：拨号次数同、CP 输入 783k→392k 省 50%；armed 空转 155 次→6 次）；小窗更早建账 |
| CP 段门槛 | 10% | 10% | 12% | 绝对值 100k/51k/31k——小窗略增防碎片拨号 |
| L1 免费清层 | 55% | 55% | 50% | 零成本层无脑早（小窗更早回收） |
| L2 账本落账 | 78% | 75% | 72% | 零 LLM 结构收缩提前无损 |
| 水位强制压缩 | 85% | 83% | 80% | 异常兜底而非常规防线（claude 1M 96.7% / kimi 85%）；小窗绝对余量 ≥33k（最大单步暴涨 29.6k + 摘要输出 20k——claude 准则） |
| keepRecentTokens | 20k | 16k | 12k | 保留区随窗缩 |
| keepMinTurns | 5 | 4 | 3 | 轮次护栏随窗缩（25% 硬顶在小窗自动限幅） |

实现：两包 `TIERS` 分档表（contextWindow 落档取缺省；显式传参恒优先），
行为面测试钉显式值、分档缺省由镜像常量专测双锁。

### 两路审查的合并结论

- 方案的技术可行性核心（P0 通道、P1 机制、换尺路径）经两路独立验证成立；
- 全部 3+3 阻断、5+4 高危、7+5 中低发现已处置——无一驳回；
- 实施前置条件：S0 真端点冒烟（anthropic 形态）+ S1 双 regime 夹具采集是两个
  「实施中定案」点，其余均已定规格。
