# LLM-RETRY 件方案（持久退避重试策略插件）

> 状态：已实施（方案审 7 处置 + 代码审处置：预算键含 session 跨会话隔离/封存会话 fail-closed/下游异常留痕）
> 级别：中级（跨包挂点、session 词表扩展、可取消定时器与 dispose 排空的并发语义）
> 上游：docs/AGENT-LOOP.md 件表；消费 agent-loop 的 agentRequestError waterfall。
> 参考思想出处：DSH packages/llm/llm-retry（持久调度/退避/可取消）；my-agent provider-retry
> （Retry-After 三态/内容分界）。砍掉 DSH 的 always 无界模式与 policyKey/retryId 投影不变量
> 全套（见 §5 裁决）。

## 0. 动机

流失败后驱动只做一次 `agentRequestError` waterfall 问询（缺省终态 error）。生产必要：
瞬态故障（429/5xx/网络断）自动退避重试；重试计数持久（崩溃恢复后不重锤限流端点）；
用户取消即时胜出。

## 1. 契约

```ts
export interface RetryPolicy {
  readonly maxRetries: number;              // ≥0
  readonly retryableCodes?: readonly string[];  // 缺省集见下
  readonly initialDelayMs: number;          // >0
  readonly maxDelayMs: number;              // ≥ initialDelayMs
  readonly jitterRatio: number;             // [0,1]
}
export function createLlmRetryPlugin(options: {
  readonly providers: Readonly<Record<string, RetryPolicy>>;  // 键 = provider 名
  readonly default?: RetryPolicy;           // 命不中 providers 时的缺省策略；两者皆无 → 委托
}): Plugin;   // name "llm-retry"，inject ["session"]
```

决策流（agentRequestError waterfall 中间件，provider = session 末次 request/context 折叠；
无路线记录 → 委托 next）：

1. 策略选取：provider = session 末次 `request/context` 折叠（agent-loop 导出
   `lastRequestContext`——单一事实一处实现）；**无路线记录（含单适配器无显式 provider 的
   最小部署形态）→ 取 `default` 策略**；无 default 才 `next`。
2. 可重试判定：`failure.code ∈ retryableCodes`（缺省集 `["http-408","http-429","http-500",
   "http-502","http-503","http-504","network"]`；精确整串匹配——code 是结构化词表，无子串
   误命中面）→ 否则 `next`。
3. 预算判定：已重试次数（见持久语义）≥ maxRetries → `next`（缺省终态 error）。
4. 退避计算：`retry`（本次为第几次重试）；`failure.retryAfterMs` 存在且 ≤ maxDelayMs →
   原样采用（0 合法=立即重试；小数秒折算由适配器完成）；> maxDelayMs → 放弃（next）；
   否则指数退避 `initial × 2^(retry-1) × 抖动因子 [1-ratio, 1+ratio]` 后 **min 封顶 maxDelayMs**
   （硬上限——先抖动后封顶，ratio=1 时不越界）。
5. 调度：**落账前显式查 `signal.aborted`**（取消不落审计事件）→ append `llm/retry` 事件
   （先于等待落账——审计时序）→ 可取消等待 delayMs → 未取消 → 返回 `{kind:"retry"}`。

session 词表扩展（log-only，docs/SESSION.md 同步——14→15 词条，types/gates 注释与 SESSION.md
词条计数一并更新）：

```ts
{ type: "llm/retry", data: { turn, step, provider, retry, delayMs, failure: { message, code? } } }
```

形状门（gates 谓词）：turn/step isCount≥0；provider 非空 isStr；retry isCount≥1（第 0 次重试
无意义）；delayMs isCount 且 0 ≤ delayMs ≤ 2^31−1；failure isObj{message 非空 isStr, code? isStr}。
连续性校验砍（折叠取 max 对重复/跳号天然确定，单写者无歧义）。

取消与处置：
- 等待可取消（payload.signal）；取消 → 不返回 retry（驱动已按 aborted 收尾）；
- 插件 dispose：abort 全部在途等待并排空（dispose promise 等 active 集 settle）；
  dispose 后被 waterfall 捕获的旧回调 → 直接委托不进策略。

RequestFailure 载荷扩展（agent-loop tokens 同步）：`{ message, code?, retryAfterMs? }`——
驱动把 settleStream 的 attempt code/retryAfterMs 透传（前版只有 message，code 断流）。

## 2. 问题域

**处理**：策略配置校验（maxRetries≥0/initial>0/initial≤max≤**2^31−1**（setTimeout 溢出钳制
阈值——超限变立即重试轰击）/jitter∈[0,1]/retryableCodes 非空串集合）；退避与 Retry-After；
进程内预算计数；可取消等待；dispose 排空；委托链（更早的 recovery 监听器先跑——本插件注册
在后，next 语义天然让先注册者决策）。
**不处理**：always 无界模式；按 model 分策略（provider 粒度够用）；重试时改写请求体
（请求体纯折叠不变量——重试请求与首次逐字节一致由驱动架构保证）。

## 3. 测试口径（对照 R1–R19/R28–R31 真缺口）

- 退避表驱动：指数序列（initial×2ⁿ 封顶）×抖动边界（ratio 0 与 1）、Retry-After 三态
  （0 立即/小数折算由适配器→≤上限原样/超上限放弃）；
- 预算：maxRetries=0 直达失败；烧尽后终态 error；调度事件先于等待落账（等待中检查 session
  事件已在——审计时序）；gates 形状门用例（retry≥1/delayMs 上界/failure 子形状/垃圾拒绝表）；
- 判定：非 retryable（如 http-401）零定时器直达；network/http-503 在缺省集内；
- 取消：退避等待中 turn 取消 → 不重拨、无残留定时器；dispose 排空在途等待；
- 副作用隔离（R11/R12 语义）：重试后请求 messages 与首次一致（失败诊断文本与部分输出
  不进重试上下文——驱动纯折叠架构验证）；
- 配置校验表：非法策略 throw（装配期）；
- 委托：无策略 provider / 无路线记录 → next 透传。

## 4. 验收清单

- [ ] §1–§3 逐条；四门全绿 + 覆盖率数字如实报告

## 5. 裁决落档

- 砍 always 无界模式（用户未点名；无界重试对限流端点是放大器，有界+Retry-After 已覆盖生产面）
  ——需要时后续加，不影响契约形状；
- 砍 policyKey/retryId/llm-retry-started 配对（DSH 支持运行期热替换策略与在途注册钉扎；
  本件策略在插件构造时定死）——后果如实落档：预算为进程内计数，`llm/retry` 事件是审计面
  （不承诺跨进程预算延续）；
- agent-loop 导出 `lastRequestContext`（本件与 token-meter 共用——同一事实一处实现）。
