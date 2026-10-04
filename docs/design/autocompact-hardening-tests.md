# 测试口径（实现前定稿）

对应方案 docs/design/autocompact-hardening.md §3 六项改动。口径先行列出，实现时逐条落成用例。

## 契约级

1. 诊断事件落 journal：每次压缩/checkpoint/摘要失败，session.events() 出现诊断事件，code 透传；词表封闭 = 方案 §2.1 枚举全集 + compact-exhausted；
2. exhausted 事件时序：`compaction/exhausted` 恰好一次、位于第 3 次失败之后、reject 返回之前；turn 终态 blocked 且 reason=compact-exhausted；
3. preStep reject 判别联合：三振后返回 `{ kind: "reject", reason: "compact-exhausted" }`；exhausted 置位后新消息直接 reject（零 LLM 调用）；成功 compact 后不 reject；
4. checkpoint 失败分类：blame=provider 计数、blame=self 不计数，journal 事件各带 blame 字段；三振仅由 provider 类凑满；
5. L2 准入：ledgerReady 且 broken=true 时 escalateL2 照常落地（去连坐后）；
6. 分段摘要：span 超预算时 LLM 调用次数 = 段数，首段无 previous-summary、后续段携带；段间 prompt 内不超 summaryInputMaxChars；
7. exhausted 重载重建：journal 尾部存在未清除 exhausted 事件 → resume 后状态置位；其后跟成功 compact 事件 → 不置位。

## 边界与异常

8. 三振计数边界：恰好 2 次失败 + 第 3 次成功 → 不停机、计数归零；
9. 退避时长：3 次尝试间隔 2s/8s（测试用假定时器）；
10. 分段边界：span 恰好等于预算 → 1 段；空 span → no-cut-point 原因码不变；段切点对齐节点边界（不劈开单个 message）;
11. thinking off：internal:summarizer 的 llm.stream 调用参数 thinking 不为 max；
12. dial 选择：hub-settings 覆盖 > catalog flash > 主 dial 回退（回退落 diagnostic）；
13. idle 缩放：base 120s + 0.5s/千 token，上限 300s（纯函数断言）；
14. session dispose：exhausted Map 与 inflight/epochs 同批清理；
15. 垃圾形状：exhausted 事件载荷缺字段 → 重建按不存在处理，不炸。

## 回归（症状命名）

16. 「924k 会话压缩静默失败无任何 journal 痕迹」：失败后 events() 含诊断事件；
17. 「breaker 永久死锁（worker 长寿致 L2 永久关闭）」：broken 置位后新 turn/start 自愈，L2 可再落地；
18. 「无过错失败（idle/空输出）与 provider 失败共计数」：self 类失败不推进 consecutiveFailures；
19. 「一次性 70 万 token 摘要请求结构性失败」：span 3 倍于预算时全部请求 ≤ 预算且最终落地；
20. 「压缩失败任务继续烧 token」：三振后第 4 步起零 LLM 调用。
