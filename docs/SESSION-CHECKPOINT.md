# SESSION-CHECKPOINT：语义持久检查点 + e2e 旅程（件 6）

状态：定稿（对抗审查 7 条处置见 §6）
归属：docs/AGENT-LOOP.md §1 件 6；处置依据 P2/P3/P12/P16。

## 0. 问题

崩溃窗口下「已确认的输入/已派发的副作用」必须可判别：

- 输入侧：claim 后 user/message 已入内存日志，但未落盘时崩溃 → 输入丢失（P3）。
- 副作用侧：tool/call 已记录、工具体已执行，崩溃后若 tool/call 不在盘上 → resume 判「未启动」
  → 重试 → **双重副作用**；在盘上 → repair 判「outcome unknown」→ 模型验证后决策。

## 1. 方案：@x-harness/session-checkpoint

单一职责插件——在两个语义边界前置 flush（sessionStore.flush 屏障），fail-closed。

### 1.1 挂点（2 个）

| 边界 | 挂点 | 行为 | 失败（fail-closed） |
| --- | --- | --- | --- |
| 模型请求前 | `agentRequest` waterfall 中间件 | `store.flush(payload.session)` 成功才 `next` | throw → 逃逸 driver turn catch → `turn/end{error}`，适配器零派发 |
| 工具副作用前 | `toolsExecute` waterfall 中间件 | payload 带 `session` 才 flush（非 agent 调用方直通） | throw（携带 reason）→ dispatch 管线捕获 → isError outcome（reason 可见），工具体零执行 |

依据：
- P2/P3 裁决「请求侧挂点挪到 agent/request（此时 system/user 已落账）」——agentRequest 在拨号前，
  覆盖 DSH 的 llm/stream 挂点且更早（请求体=纯折叠，flush 后派发窗口内日志即请求前缀）。
- 副作用边界 = DSH 的 tools/execute 思想：tool/call 记录先于工具体持久。
- P16：inject 去掉 llm——本插件 inject 仅 `["session"]`（不挂 llm/stream）。
- 不挂 preStep：每步 agentRequest 已 flush 前一步提交，preStep 挂点冗余。

### 1.2 flush 语义

`sessionStore.flush(id): Promise<Result<true>>`——空屏障语义（未装配持久化插件时成功不承诺字节落盘，
docs/SESSION.md §1.5）。checkpoint 以 Result 判定：`!ok` 即 throw（store 已把 listener 异常收敛为
`flush-failed:*` reason）。不直接 dispatch `sessionFlush` token——公共 API 面优先，且 store 捕获语义明确。

### 1.3 尾巴窗口（有意不覆盖）

- 最后一步 `turn/end`：崩溃后由 repair closers 关闭（resume 合成 interrupted 收尾）——checkpoint 不在
  turn/end 后追加 flush；dispose 路径由持久化层 drain-then-close 覆盖（dispose 语义见 §2.6）。
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

每步 1 次（agentRequest）+ 每工具调用 1 次（toolsExecute）flush；并行池 N 调用 = N 次串行 drain
（首次已覆盖整池 tool/call，其余为纯 fsync 屏障）。正确性优先的有意选择；批量化/合并留给后续策略插件。

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
  真适配器单 turn 冒烟（一条 user → 非空回应 + completed 收轮 + jsonl 落盘）。
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
  - 空 barrier：未装 jsonl 持久化时 flush 成功（空屏障语义）旅程照常。
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
