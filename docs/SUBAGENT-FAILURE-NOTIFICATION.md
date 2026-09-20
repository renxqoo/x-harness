# 子代理失败通知根治（异常终态显式回传）方案

> 状态：已实施（2026-09-20 会话内四轮收敛，定稿即实施）
> 级别：中（跨 core/session + agent-loop + agent-delegation）
> 来源：事故 20260920T130824-ljcg3f——子代理 max-tokens 空产出后，主代理收到的完成
> 通知是含糊状态词 `finished: max-tokens`，无从知道「发生了什么」。

## 缺陷本质（治本判据）

用户契约：**子代理任何非正常结束（一切异常路径）必须立即终止执行，并把「发生了什么」
作为显式错误信息回传主代理——主代理不猜、不轮询、不解读含糊状态词；失败子代理保持
idle 可唤醒。** 对照现状四处断裂：

- **失败载荷被折平**：turn/end 事件里 error 带 `message/code`、aborted 带 `cause`，
  但 `childReport` 只取 `reason.kind` 一个字段——上游有但没透传（弱形态违例）；
- **blocked 连事件里都没有原因**：preStep reject 载荷本有 `reason: string`
  （agent-loop tokens.ts PreStepDecision），`beginStep` 转 `{kind:"blocked"}` 时丢弃，
  turn/end 只落 `{kind}`；
- **异常终态不终止**：链式条件只看「未取消 ∧ 非 blocked ∧ 有 next-turn」——error /
  max-tokens 后仍链式消费排队消息，失败上报被推迟；
- **通知缺档案指针**：完成通知不带子会话 session id，主代理要翻 spawn 历史才能定位
  events.jsonl 现场。

## 契约

- **通知形态**（notificationText，agent-delegation）：

  ```
  [agent-notification] agent <agentId> failed: <原因句>     ← max-tokens / error / blocked / interrupted
  [agent-notification] agent <agentId> stopped: <cause>     ← aborted
  [agent-notification] agent <agentId> finished: completed  ← 正常（词面沿用，摘要照旧）
  session: <子会话 id>
  usage: {...}                                               ← 有则带
  ```

  不带恢复建议文案（用户裁决——主代理自己知道有 agent_message）；`session:` 行一切
  终态都带（指回 `~/.x-harness/sessions/<id>/events.jsonl` 现场的指针）。
- **原因句词表（单一真相）**：`failureDetail(report)` 纯函数，notificationText 与
  reportText 共用：
  - max-tokens 无摘要 → `hit the output token limit before producing any report (no summary)`；
  - max-tokens 有摘要 → `hit the output token limit (last output may be truncated)`；
  - error → `<message>`（code 非空附 `(code: <code>)`——空串视同缺席；message 缺席兜底
    `turn ended with error`）；
  - aborted → cause 缺省/空串护栏 `cancelled`；
  - blocked → `step rejected by middleware: <reason>`（reason 缺席护栏同构）；
  - interrupted（repair 崩溃残卷铸造的已知 kind）→ `turn interrupted before completing
    (crash recovery)`——已知终态如实铸句，不落 unknown；
  - 未知 kind（fail-closed 按 error）→ `turn ended abnormally (unknown reason kind)`。
- **blocked 原因落账**：TurnEndReason/TurnOutcome 的 blocked 变体扩可选 `reason`；
  session 门（gates.ts isTurnEndReason）同构收编（`reason` 在场必须 string）；
  beginStep 从 reject 载荷提取（形状收窄：null/undefined/垃圾决策如实按无 reason 落，
  不炸），turnEndData 落账（空串省略——与 aborted.cause 同口径）。
- **立即终止（链式条件改写）**：`chainsNextTurn` = 未取消 ∧ 终态为 completed ∧ 有
  next-turn 才链；异常终态（error / max-tokens / aborted / blocked）排队消息**原地保留**
  （不丢——下次 kick 的 step0 领取消费），kick 退出、立即 idle → 通知立即出。
  **replay 边界不发假 idle**：kick finally 先判锁存唤醒 replay 再发布 idle——replay 是
  「即将继续」，假 idle 会让同步监听者（evictIdle 驻留档化 / 邮箱状态镜像）在边界上
  做生命周期决策（dispose 压掉 replay + clear 掉锁存的排队消息）。锁存唤醒 replay
  本身是用户主动唤醒语义（飞行中新 followup 到达），照常放行——与「失败子代理 idle
  可唤醒」同向。
- **task_output 同口径**：reportText 失败路径显式 `failed: <原因句>` / `stopped: <cause>`，
  一切终态带 `session: <id>` 行；占位通知（子会话缺档）同样带 session 行。
- **失败子代理保持 idle 可唤醒**：不 dispose、不自动 stop；worktree 清理维持显式
  task_stop 触发（既有语义不动）。

## 问题域

处理：上列四处断裂 + 五态词表测试锚。

不处理（归属落档）：

| 事项 | 归属 |
| --- | --- |
| 主代理 task_output 权限冻结（本事故主因，unknown-tool ask） | 另件立项（isControlTool 铺面已论证） |
| thinking 落账（8192 token 思考在盘上不存在——「对话」近乎空） | THINKING-STREAM 契约 5 显式设计，改动面大，另件 |
| attempt 内网络级重试 | 既有韧性语义，不属于「执行终止」范畴，不动 |
| autocompact reject 文案质量 | 本件只透传不铸词；词面优化归 autocompact |

## 测试口径

- **五态表驱动**（agent-delegation 纯函数直测）：completed / max-tokens（有/无摘要）/
  error（message+code）/ aborted（cause）/ blocked（reason）/ interrupted ×
  notificationText / reportText —— 断言 failed/stopped/finished 前缀、原因句字段透传、
  `session:` 行（词面断言带 `\n` 边界防前缀假绿）。
- **症状回归**（用例名注明症状）：子代理 max-tokens 空产出（content:[]——本案形态）→
  通知含 `failed:` + `no summary` + 子会话 session id；主代理零轮询即知成败；task_output
  同口径；失败子 list 状态 idle + agent_message 可投递（不 dispose 不自动 stop 锚）。
- **世界级旅程**（notify-path 装置）：子 error turn → 父收到的通知含 `failed: <message>`
  与 session id（既有用例断言 `finished: error` 处翻转为新词表）；占位通知带 session 行。
- **驱动层**：preStep reject → turn/end 落 `{kind:"blocked", reason:"guard"}`（既有
  用例扩断言）；**异常终态不链式的可区分锚**——kick 前向 session 预插两条 next-turn
  （step0 只领队首），error/max-tokens 收轮后断言队尾消息原地保留、无第二次模型调用、
  steer 再唤醒后消费（旧实现此态链式，翻绿即锚定）；**锁存唤醒 replay 语义**——飞行中
  followup 在 error 收轮后照常被 replay 消费，且状态序列 running→running→idle 无假
  idle 闪断；垃圾决策防御——中间件返 undefined → blocked 如实无 reason 不炸；reject
  reason 空串 → 省略落账。
- **session 门**：blocked reason 非 string → 门拒（isTurnEndReason 单测补行）。

## 验收清单

- [x] 五态+interrupted 通知文本全锚（前缀 + 原因透传 + session 行 + 词面边界）
- [x] 症状回归：max-tokens 空产出 → 显式 failed + session id + 失败子 idle 可唤醒
- [x] blocked reason 落 turn/end（驱动 + 门双侧）+ 垃圾决策/空串防御
- [x] 异常终态不链式可区分锚：next-turn 队尾保留、无追加模型调用、唤醒后消费
- [x] replay 语义：飞行中 followup 照常消费、无假 idle 闪断
- [x] completed 链式与 max-tokens 粘性既有用例不动即绿
- [x] AGENT-DELEGATION §5.1 / AGENT-LOOP-DRIVER 链式与词表行同变
- [x] 四门全绿 + 覆盖率只升不降 + 数字如实报告

## 审查处置（2026-09-20 代码收口前三路并行对抗审查）

- **H1 不链式用例无锚定力（测试面+契约面同源）**：核实属实——inject 落 next-step、
  飞行中 followup 走 replay 豁免，旧实现下两用例照样绿。处置：重写为「kick 前预插
  next-turn ×2 + steer 唤醒」的可区分构造（旧实现此态链式、新实现不链）。
- **M1 beginStep 对 null/undefined 决策抛 TypeError（契约面+并发面同源）**：核实属实
  （waterfall 不校验输出形状，`await next()` 后隐式返回 undefined 是常见笔误）。处置：
  形状收窄 + undefined 决策回归用例（blocked 如实无 reason）。
- **M2 idle→replay 间隙假 idle（并发面）**：核实属实——旧实现 error+排队 followup 在
  while 内链式无 idle 间隙，收紧后退到 finally 先发 idle 再判 replay，同步监听者
  （evictIdle/邮箱镜像）可在闪断内做生命周期决策压掉 replay 并 clear 排队消息。处置：
  replay 判定挪到 idle 发布之前、replay 边界不发假 idle（状态序列锚）。
- **M3 interrupted 终态落 unknown 词面（契约面+并发面同源）**：核实属实（repair 铸造的
  已知 kind）。处置：专门铸句 + 词表/文档/表驱动用例同步。
- **M4 completed 首行词面文档滞后（契约面）**：处置：两文档对齐 `finished: completed`。
- **M5 error code 空串词面 `(code: )`（契约面）**：处置：failureDetail 端空串视同缺席。
- **M6 飞行中 followup 的 replay 语义零覆盖（并发面）**：处置：replay 消费 + 无假 idle
  状态序列锚（与 M2 同一批）。
- **L 级**：AGENT-LOOP-DRIVER F2 行残留旧口径（处置：同变）；PreStepDecision.reject
  .reason 强声明与弱防御的表述矛盾（处置：tokens.ts 注释钉死「声明强形态、内核弱形态
  防御」）；占位通知 session 行/reportText 首行/唤醒内容/词面边界断言强度（处置：
  逐条补强）；waitFor 显式 timeout（处置：新用例统一 5s）。
- **lint 门现状红属他人基线**（spike.test.ts no-console ×2、fence-grep.test.ts 未用
  import），不在本件文件集内，如实标注不越界代修。

## 裁决（2026-09-20 会话四轮收敛）

- 通知只带 agentId + session id + 显式原因（不带对话内容——session id 即现场指针；
  不带恢复建议文案）。
- 异常终态不链式（「立即终止执行」字面语义）；排队消息不丢、唤醒后消费。
- 失败子代理保持 idle 可唤醒（不 dispose 不自动 stop）。
- thinking 落账与权限冻结两边界显式另件，不在本批。
