# SESSION-CHECKPOINT：语义持久检查点 + e2e 旅程（件 6）

状态：定稿（对抗审查 7 条处置见 §6）
归属：docs/AGENT-LOOP.md §1 件 6；处置依据 P2/P3/P12/P16。

## 0. 问题

崩溃窗口下「已确认的输入/已派发的副作用」必须可判别：

- 输入侧：claim 后 user/message 已入内存日志，但未落盘时崩溃 → 输入丢失（P3）。
- 副作用侧：tool/call 已记录、工具体已执行，崩溃后若 tool/call 不在盘上 → resume 判「未启动」
  → 重试 → **双重副作用**；在盘上 → repair 判「outcome unknown」→ 模型验证后决策。

## 1. 方案：@x-harness/session-checkpoint

单一职责插件——在三个语义边界设 flush 屏障（sessionStore.flush）：模型请求前与工具副作用前
前置且 fail-closed；turn 收尾后异步告警式（不阻断收轮链）。

### 1.1 挂点（3 个）

| 边界 | 挂点 | 行为 | 失败 |
| --- | --- | --- | --- |
| 模型请求前 | `agentRequest` waterfall 中间件 | `store.flush(payload.session)` 成功才 `next` | fail-closed：throw → 逃逸 driver turn catch → `turn/end{error}`，适配器零派发 |
| 工具副作用前 | `toolsExecute` waterfall 中间件 | payload 带 `session` 才 flush（非 agent 调用方直通） | fail-closed：throw（携带 reason）→ dispatch 管线捕获 → isError outcome（reason 可见），工具体零执行 |
| turn 收尾后 | `sessionEvent` 过滤 `turn/end` | fire-and-forget `store.flush`（旁观者：不阻断收轮链） | 告警式：stderr `session-checkpoint/turn-end-flush-failed`（同会话一次）；pending 保留，由下一 agentRequest 屏障（fail-closed）与 dispose drain-then-close 兜底重试 |

依据：
- P2/P3 裁决「请求侧挂点挪到 agent/request（此时 system/user 已落账）」——agentRequest 在拨号前，
  覆盖 DSH 的 llm/stream 挂点且更早（请求体=纯折叠，flush 后派发窗口内日志即请求前缀）。
- 副作用边界 = DSH 的 tools/execute 思想：tool/call 记录先于工具体持久。
- turn 收尾边界挂 `sessionEvent` 过滤 `turn/end`：`turn/end` 属 session 闭合词表（docs/SESSION.md
  §1.3），判别联合下拼写有编译期检查（autocompact 监听 sessionEvent 过滤 turn/* 为同款先例）。
  排序：持久化插件对 sessionEvent 只做同步 pending 入账，drain 段经 per-session 串行链在本轮
  同步广播之后执行——drain 必含 turn/end，且同一链 FIFO 保证先于下一 turn 的请求屏障。
- P16：inject 去掉 llm——本插件 inject 仅 `["session"]`（不挂 llm/stream）。
- 不挂 preStep：每步 agentRequest 已 flush 前一步提交，preStep 挂点冗余。
- 装配契约：本插件须晚于 session-persistence-jsonl 装载（context teardown 逆序回卷时本插件
  挂点先拆、持久化终排空殿后）；调换顺序会使拆除期触发的 flush 落进空屏障（成功不承诺字节）。

### 1.2 flush 语义

`sessionStore.flush(id): Promise<Result<true>>`——空屏障语义（未装配持久化插件时成功不承诺字节落盘，
docs/SESSION.md §1.5）。checkpoint 以 Result 判定：`!ok` 即 throw（store 已把 listener 异常收敛为
`flush-failed:*` reason）。不直接 dispatch `sessionFlush` token——公共 API 面优先，且 store 捕获语义明确。

失败语义的边界不对称是有意的：请求/工具边界有下游可阻断（适配器派发、工具体执行），fail-closed；
turn 收尾边界无下游可阻断（turn 已收尾），告警不 throw——失败后 pending 按 docs/SESSION.md §1.8
保留，由下一 turn 的 agentRequest 屏障（fail-closed）与 dispose drain-then-close 兜底重试。

### 1.3 强度边界与残卷形状

- turn 收尾触发异步 flush：崩溃丢失窗口 = flush 在飞窗口（毫秒级），而非「到下一触发点（可能
  永不）」。`whenIdle`/idle 状态不承诺字节已 fsync——读盘必经 flush 屏障（/export 的显式屏障
  因此保留）。
- 崩溃残卷的括号形状仍由 repair closers 关闭（resume 合成 interrupted 收尾）；正常收尾卷的
  turn/end 已在盘，repair 对已闭合 turn 不补 closers——两机制方向一致，只会减少合成量。
- 流内 text-delta：不落日志（assistant/message 一步落账），无 checkpoint 语义。

### 1.4 ToolCallRequest 扩展

`tools` 包 `ToolCallRequest` 增可选字段 `session?: SessionId`；`agent-loop` 工具调度
（tool-calls.ts）的排他与并行池两路 dispatch 均携带 `session.id`。缺省不携带——非 agent 宿主调用面不变。
dispatch final 的同一性断言扩展 `req.session !== request.session` → request-altered（中间件不得剥离
session——那会静默重开双重副作用窗口）。

### 1.5 包结构

```
packages/session-checkpoint/
  src/plugin.ts    sessionCheckpointPlugin（inject ["session"]）
  src/index.ts     barrel
  src/__test__/plugin.test.ts
```

依赖：@x-harness/core、@x-harness/session（store）、@x-harness/tools（toolsExecute token）、
@x-harness/agent-loop（agentRequest token）。token 为模块级定义，宿主未装对应插件时监听休眠（无害）。
中间件意图位：toolsExecute 上 checkpoint 应为最外层中间件（装载序），agentRequest 任意。

### 1.6 flush 频率语义（有意选择）

每步 1 次（agentRequest）+ 每工具调用 1 次（toolsExecute）+ 每 turn 收尾 1 次（turn/end）flush；
并行池 N 调用 = N 次串行 drain（首次已覆盖整池 tool/call，其余为纯 fsync 屏障）。正确性优先的
有意选择；批量化/合并/空批跳过 fsync 留给后续策略插件。

## 2. e2e 旅程（P12：进默认门）

`bun run e2e` 既有 plugin-manager 场景之外，增加 agent 全链旅程（packages/e2e/src/agent-journey.ts，
main.ts 编排先后两场景）：

1. 装配：session + session-persistence-jsonl（root=tmp 隔离区）+ tools + llm + system-prompt +
   agent-loop + session-checkpoint；脚本化假 LLM 适配器；真实工具（副作用计数）。
2. 多步 turn：followup → tool_use → tool/call→tool/result → 下一步完成文本；事件序断言。
3. checkpoint 证据：假适配器在流内读 jsonl 文件——请求前缀（system/message + user/message 行集）已落盘
   （「先持久后派发」的时点证明；request/header 在 waterfall 返回后才落账，不在本保证内）。
   jsonl 布局：`<root>/<id>/events.jsonl` + `header.json`。
4. steer 流中注入 → 同 turn 续航消化。
5. cancel 悬停流 → interrupted 消息 + aborted cause。
6. 崩溃残卷 → 进程重开（同 root 新装配）→ resume(id)：repair closers 入 seed（悬空 tool_use 合成
   两态文案/括号补齐）→ 新 followup 正常工作；resume 后 jsonl 同 id 可验证续写。
   dispose 语义：AgentHandle.dispose 先 `store.flush` 再封存（字节完整后才 dispose——resume 不读截断卷）。

## 3. real 门（P12 口径：契约级生产可用 + 真凭证 opt-in）

`bun run e2e:real`（packages/e2e/src/real.ts）：

- env `X_HARNESS_E2E_REAL_API_KEY` + `X_HARNESS_E2E_REAL_BASE_URL` + `X_HARNESS_E2E_REAL_MODEL` 齐备 →
  真凭证全链旅程：一条「你好」+ 自定义 `output` 工具——模型 tool_use → 工具体执行（副作用可观察）→
  tool/result 回传 → 下一步消化 → completed 收轮 + jsonl 落盘。
  `X_HARNESS_E2E_REAL_PROTOCOL ∈ {openai, anthropic}`（缺省 openai；缺席不触发 skip；
  BASE_URL 语义随协议——anthropic 是 `/v1/messages` 根，openai 是 `/chat/completions` 根）。
- 缺席 → 显式 skip：打印 `skip: 1（env 凭证缺席——P12 opt-in）`，退出码 0（缺席不是失败）。
- 真凭证旅程不进默认门。

## 4. 测试口径

- checkpoint 单测（真实装配 session+jsonl+tools+agent-loop+checkpoint）：
  - 请求边界：flush 成功后适配器才派发（流内验盘上已有 user/message）；
  - 请求边界 fail-closed：flush 失败（jsonl root 指向不可写路径）→ turn/end{error}、适配器零调用；
  - 工具边界：payload 带 session → 工具体执行前盘上已有 tool/call；不带 session 直通；
  - 工具边界 fail-closed：flush 失败 → 工具体零执行 + isError 结果（reason 可见）；
  - 空 barrier：未装 jsonl 持久化时 flush 成功（空屏障语义）旅程照常；
  - turn 收尾边界：turn 完成（不 dispose）后盘上 events.jsonl 已含 assistant/message 与
    turn/end 行（轮询等待异步 flush 落定，超时失败带当前盘上行集；末行即 turn/end 防乱序假绿）；
  - turn 收尾告警式：flush 失败（不可写 root）→ stderr 告警出现（同会话去重）、turn 收尾链
    不被阻断（turn/end 照常落账）。
- e2e 旅程退出码背书（must 断言逐步报点）。

## 5. 边界与非目标

- checkpoint 不做 fsync 策略、不做压缩/滑窗（后续策略插件）；
- 不改 session 词表与 repair 语义（件 5 已收口）；
- 真凭证多轮压力、断网重试等 real 深旅程：非本件（P12 只要求单 turn 冒烟 opt-in）。

## 6. 对抗审查处置（7 条）

R1（P0）jsonl drain 排空竞态：pending 活引用在 await 期间膨胀、按膨胀长度截断——未写事件被误切丢弃
  且 flush 报成功（违反 SESSION.md §1.8 已文档化的不变量）→ 改长度快照；回归用例「排空期间新到事件不丢」。
R2（P1）toolsExecute 失败通道：不借「未调 next」的 I2 违约文本当控制流 → 中间件主动 throw 携带
  `checkpoint-flush-failed:<reason>`，dispatch 收敛为 reason 可见的 isError。
R3（P1）dispose→resume 竞态：sessionDisposed 终排空 fire-and-forget、无 barrier 点 → AgentHandle.dispose
  在 store.dispose 前 await store.flush（对齐 SESSION.md 消费方纪律「dispose 前先 flush」）。
R4（P2）session 同一性：dispatch final 断言扩 req.session（中间件剥离 session = request-altered）。
R5（P2）e2e 断言词表钉死：请求时点保证 = {system/message, user/message} 行集（request/header 不在内）。
R6（P2）flush 频率声明为有意选择（§1.6）。
R7（P3）逃逸 throw 的 step 括号：driver turn catch 对已开的 step/end 补闭合（错误路径括号形状一致）；
  中间件意图位声明（§1.5）。
R8（P1）turn 收尾尾巴窗口（用户裁决）：原 §1.3「有意不覆盖」作废——turn 收尾必须是耐久边界。
  新增第三挂点（sessionEvent 过滤 turn/end，告警式异步 flush）；崩溃窗口收敛为 flush 在飞窗口，
  §1.3 如实落档强度。
R9（P1）whenIdle 语义钉死：whenIdle/idle 状态不承诺字节已 fsync，读盘必经 flush 屏障——
  挂点注释与 §1.3 双落点，防未来消费者踩坑。
R10（P2）装配顺序契约固化：本插件须晚于 session-persistence-jsonl 装载（teardown 逆序回卷
  本插件先拆、持久化终排空殿后）——§1.1 依据与两端插件头注释双落点。
R11（P2）告警形态对齐仓库惯例：结构化前缀 `session-checkpoint/turn-end-flush-failed
  session=<id> <reason>`（对齐 autocompact/compaction 的 `<插件>/<code> session=` 报文）；
  同会话去重 + sessionDisposed 摘除（dead 闩会话连跑多 turn 不刷屏、无泄漏）。
R12（P2）测试假绿/假红防护：成功路径轮询读盘钉死异步落定（whenIdle 后直接读盘会 flaky）；
  失败路径 spy stderr 验证告警真实出现——两路径均有断言，非仅靠覆盖率。
