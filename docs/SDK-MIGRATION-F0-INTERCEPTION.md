> 状态：定稿（收口审查处置后）。迁移单元：三域拦截面最后三块基础接口（SDK-DESIGN §6.1）。
> 行为规格基线：final 透传缺省 = 零中间件时全链路行为不变（既有测试零改写）；改写版即落账版（「模型可见必落盘」）；流拦截只影响实时面（settle 落账为准）。

## 契约（收口审查 3.1/1.1/1.2/1.4/2.1/2.2/3.3 处置后）

- **agent/pre-step（改写）**：载荷含 `claim`（本步领取批次——改写输入源；`messages` 为全史只读观察面）；决策 `{kind:"enter", messages}` 落账走重写版（claim 记原始）；**step0 改写空 = 落 durable `clear` 后闭 turn**（repair trailingClaims 由 clear 复位——运行态/恢复态一致）；改写条目过形状门（`{id, content[]}[]`）——违约可读 throw 经 agentError 面；step≥1 改写空 = 跳过 user 追加照常拨号（不对称性——已知语义）。
- **agent/assistant-settle（纠）**：输出契约**只 content/stopReason**（interrupted 内核独占——中间件不可移除中断标记）；stopReason 词表门（stop|max-tokens）；**不与 abort 赛跑**（中断是合法完成态；挂起防护与 preStep/request 同契约——waterfall 不得无限挂起，文档承载）；usage 不进载荷（session/event 已覆盖——最少面）。
- **agent/llm-stream（agent 层流包裹）**：**与 @x-harness/llm 的 "llm/stream"（root 层全局面）是两层串联**（本面 final = llm.stream → 其内再经全局面）——改名 agent/llm-stream 避词表碰撞；中间件须返回 AsyncIterable（违约可读 throw，不伪装 LLM 故障）且**每调新迭代器**（重试重派——幂等契约）；迟到帧守卫（abort 后不 push 不 emit）。

## 7. 实施记录（2026-09-20，feat/plugin-platform 分支）

- **交付物**：`PreStepDecision` 改写分支（改写版即落账版；step0 改写空=闭 turn——领取项被中间件显式清除，与 reject[回灌] 的差异为文档化语义）；`agent/assistant-settle` waterfall（settle→append 之间，content/stopReason/interrupted 可纠，usage **不进载荷**——session/event 已覆盖，最少面原则）；`llm/stream` waterfall（包 adapter.stream，注入/截断帧）；plugin.ts 双 dispatch 接线（final 透传）；barrel 导出补齐。
- **门禁数字**：typecheck ✓ lint ✓（嵌套回调抽 prefixStream/rewrite 平铺）test **146 文件/1734 用例**（1730 + F0 专测 4）e2e 全旅程 ✓。
- **等价锚**：final 透传缺省 = 零中间件时全链路行为不变（既有 1730 零改写通过）。
- **挂账**：F0+P1 设计审查进行中（收口后处置台账补记本节）。

## 8. 收口审查处置台账（2026-09-20）

**高×4**：3.1 llm/stream 词表碰撞（agent-loop 流 token 改名 **agent/llm-stream**，与 llm 包 root 层全局面两层串联——文档化关系）；1.1/4.1 pre-step 载荷缺领取批次（**补 `claim` 字段**——P1 transformMessages 输入源接通）；1.2 step0 空改写 repair 复活分叉（**落 durable clear**）；（4.1 并入 1.1）。
**中×8**：1.4 改写形状门（可读 throw）；2.1 settle stopReason 词表门；2.2 interrupted 内核独占（输出契约收窄 content/stopReason）；2.3 settle 不与 abort 赛跑（中断=合法完成态；挂起契约与既有面同款）；3.2 迟到帧守卫；3.3 iterable 违约可读 throw；4.2 P1 类型三修；4.3 transformToolResult 注册序裁决（prepend 选项）。
**低**：3.4 流中间件幂等契约（每次新迭代器——错误文案承载）；3.5 全史深冻性能注记；4.4 tapSessionEvents 三红线（O(1)/无过滤参数/异常静默 sink）。
**文档**：AGENT-LOOP-DRIVER F6 勘误；本文件占位骨架换真规格；DESIGN §6.1 形状同步；P1 类型修正。
**回归用例 +3**：空改写 durable clear / claim 载荷 / 形状门可读失败（agentError 面）。
