# TOKEN-METER 件方案（会话用量记账 + 估算）

> 状态：已实施（方案审处置 + 冻结深度/溢出 O(1) 短路处置）
> 级别：中（跨包读 session 事件、增量折叠与冷启动重建的一致性、fail-closed 校验）
> 上游：docs/AGENT-LOOP.md 件表。
> 参考思想出处：DSH token-meter 的 tokenUsage 投影与 turn-usage（M15/M16/M21/M22 语义）；
> my-agent estimateUsage（chars/4 口径）。砍掉 DSH 的 surface/route 计价与压力投影（见 §5）。

## 0. 动机

生产 agent 必须能回答「这个会话花了多少 token、走了哪些路线」：成本归因、预算门、
异常检测都依赖。usage 已随 assistant/message 落账（件5），缺的是记账面：聚合、路线归因、
失败尝试计费、turn 粒度。

## 1. 契约

```ts
export interface RouteUsage { readonly provider: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number }
export interface TurnUsage { readonly turn: number; readonly inputTokens: number; readonly outputTokens: number; readonly routes: readonly RouteUsage[] }
export interface SessionUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number;
  readonly attempts: number;              // 有 usage 的 assistant/attempt + assistant/message 总数
  readonly turns: readonly TurnUsage[];
}
export interface TokenMeterService {
  usageOf(sessionId: SessionId): SessionUsage | undefined;   // 未知会话 → undefined
  estimateText(text: string): number;                        // 上界口径：ASCII/空白 len/4、非 ASCII 1.25/字、向上取整（UTF-16 计长）
}
export const tokenMeter = defineService<TokenMeterService>("token-meter");
export const tokenMeterPlugin: Plugin;   // name "token-meter"，inject ["session"]
```

折叠规则（纯 session 事件投影，replay/resume 后一致）：
- `assistant/message{usage}` → 计账；归因路线 = 该消息**之前**的末次 `request/context`
  （provider+model）；无路线记录 → 归因 `{provider:"(unknown)", model:""}` 桶；
- `assistant/attempt{usage?}` → 计账（**失败尝试也计费**——重试很贵，M16）；同路线归因。
  **写侧认领**：agent-loop step.ts 的 attempt 落账点附加
  `...(accum.usageSnapshot !== undefined ? { usage } : {})`（失败尝试中断前已收的 usage 帧）——
  本件验收清单含此改动；
- attempts 口径矩阵（钉死）：样本 = 带 usage 字段的 assistant/message 与 assistant/attempt；
  | 样本形态 | token 计账 | attempts 计数 |
  |---|---|---|
  | usage 有效（安全整数 ≥0，`{}` 空对象视为缺席） | 计 | 计 |
  | usage 缺席 / `{}` | 不计 | 不计 |
  | usage 垃圾（负数/非整数/超安全整数） | 丢弃 | 不计 |
- `session/end-seed`（resume 边界）→ 折叠不重置（历史账单延续，M17「表面替换不抹历史账单」
  同精神——计费只加不减）；
- 数值校验 fail-closed：usage 字段非安全正整数 → 该样本丢弃（不崩、不部分计入），
  attempts 不计——垃圾事件不污染账本（M22 精神）。

聚合口径：inputTokens/outputTokens 为各样本累加；totalTokens = input+output（不重复计：
流内 usage chunk 不单独落账——驱动只在结算时落一次 message/attempt usage，M15「同值只计一次」
由架构天然保证）。溢出安全整数 → 该会话折叠 fail-closed 返回 undefined（M23）。

实现形态：增量（sessionAuditEvent 审计通道监听更新 per-session 聚合（微任务级投递——读侧在 whenIdle/屏障后，时序天然覆盖）——**监听器只更新已存在条目；
未知会话一概丢弃**，等 usageOf 冷启动全量折叠：晚装载时对活跃会话的后续事件建空账会钉死
错误数字）+ 冷启动（usageOf 遇未知会话 → store.get(id).events() 全量折叠入缓存）+
sessionDisposed 摘缓存（防泄漏）。
单写者：同 id 事件序由 session 单写者保证；折叠幂等（重放同事件不双计——以事件 seq 游标推进）。

session 词表扩展（docs/SESSION.md 同步——词条计数 14→15 一并更新）：`assistant/attempt`
data 扩可选 `usage?: { input?: number; output?: number }`（此前 attempt 只落 error 文本，
失败尝试的 usage 现在可计费）。

## 2. 问题域

**处理**：usage 聚合（session/turn/route 三粒度）、失败尝试计费、路线归因、fail-closed
校验、估算函数、增量+冷启动折叠、缓存生命周期。
**不处理**：成本折算（费率表归计费件）；请求压力投影/压缩水位触发（归后续压缩件——
estimateText 是它的预留口径）；cache/reasoning 桶细分（TokenUsage 契约只有 input/output——
扩桶是 LlmChunk 契约变更，届时随压缩件裁决）。

## 3. 测试口径（对照 M15/M16/M21/M22 真缺口）

- 记账：message usage 计入正确 turn/route；attempt usage 计费且与成功 message 并存；
  attempt 无 usage 只计 attempts；
- 归因：末次 request/context 之前的消息归旧路线、之后归新路线（换模型分桶）；无路线 →
  unknown 桶；
- 边界：空会话 undefined；垃圾 usage（负数/小数/非整数/超安全整数）样本丢弃且 attempts
  不计；聚合溢出 → undefined；`usage:{input:0}` 为有效零样本（计入 attempts）；
- 一致性：增量折叠与全量折叠结果相等（同事件流两种路径断言相等）；resume 后（end-seed
  边界）账单延续；同事件重放不双计（游标）；**晚装载**（事件到达时插件未装/未知会话 →
  usageOf 冷启动后账目完整）；
- 生命周期：sessionDisposed 后 usageOf → undefined（缓存摘除）；冷启动未知会话全量折叠；
- 估算：estimateText 表驱动（UTF-16 code unit 计长：空 0、1-3 字符 1、4 字符 1、5 字符 2；
  上界桶：CJK 1.25/字、emoji 按 2 单位入上界桶、混合分段折算、控制空白按 len/4）；
- 契约：token 名锁定。

## 4. 验收清单

- [ ] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告

## 5. 裁决落档

- 砍 surface/route 计价与 contextPressure 投影（DSH 为压缩件的影子计价机制——压缩件未立项，
  提前搬会带进无消费方的复杂度）；estimateText 保留为压缩件预留口径（裁决已随
  docs/COMPACTION.md 生效：chars/4 升级为 CJK 上界口径——ASCII/空白 len/4、非 ASCII
  1.25/字；`WIDE_TOKENS_PER_CHAR` 为费率单一真相）；
- 砍 cache/reasoning 桶（TokenUsage 契约层面只有 input/output，扩桶属跨件契约变更）；
- 失败尝试计费采纳（M16）——重试的成本可见性是生产必要面（写侧改动由本件认领，见 §1）。

## 6. 方案审查处置

采纳：attempt usage 写侧认领（P1）；晚装载监听器纪律「未知会话不建账」（P2）；attempts
口径矩阵钉死（P2）；`usage:{input:0}` 有效零样本、`usage:{}` 视为缺席（P3）；estimateText
按 UTF-16 code unit（P3）；SESSION.md 词条计数连锁列入实现清单（P3）。
