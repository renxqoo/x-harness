# 流截断已收内容落盘（thinking 全路径 + attempt 已收正文）方案

> 状态：已实施（2026-09-21 用户裁决直接修复——单轮方案+实现连续完成）
> 级别：中（跨 llm→agent-loop→core/session 三层；session 事件契约扩形）
> 来源：事故 20260920T152852-xx03bt——glm-5.3 + thinking:high 下 step 14 烧 34000
> 输出 token 全程思考流，UI 实时可见，终止后 WAL 零落盘（`content:[]`）。

## 缺陷本质（治本判据）

上游 LLM 流已交付的数据（thinking 增量 / 错误前已收正文增量），框架在结算层丢弃：
- **thinking**：`StreamAccumulator` 对 `thinking-delta` 直接 break（THINKING-STREAM
  契约 5「仅瞬时广播、不落账不回传」）——一切终止路径零落盘；
- **attempt 已收正文**：`runAttempt` 的 attempt 分支只落 `error+usage`，`accum` 里
  截止错误时已收的 text/tool_use 增量不进账——无任何裁决背书的纯信息丢失。

**治本拆两半**：契约 5 的「不落账」与「不回传」是两个可独立成立的决定——本件翻转
前者（落盘，供档案/诊断/resume 查看），维持后者（`surfaceToMessages` 白名单投影，
thinking 永不进请求体）。attempt 补已收增量是补齐既有事件的本义（attempt 语义 =
「这次尝试收到了什么、为什么没成」）。

## 契约

- **`assistant/message` 事件扩可选字段 `thinking?: string`**：本 attempt 全量思考文本
  （增量拼接；缺席=无思考）。落账面：正常 stop / max-tokens / interrupted（abort 且
  有正文）三条 message 路径都带。缺席字段省略（空串不落——与既有可选字段口径一致）。
- **`assistant/attempt` 事件扩可选字段 `content?: ContentBlock[]` 与 `thinking?: string`**：
  截止错误/中止时已收的增量（text 拼接块 + 已聚积 tool_use 块 + 思考全文）。原有
  `error`+`usage` 语义不变。
- **门收编**（gates.ts）：两词条新增字段校验——`thinking` 在场必须 string；
  attempt 的 `content` 在场必须过 `isContentBlocks`。加字段安全：writer 续写
  `canonicallyEqual` 键序无关；archive 读回过 `validateSessionEvents` 走同门。
- **投影不变**：`surfaceToMessages` 白名单不扩——thinking 落盘但不回传（请求体、
  KV cache 前缀、压缩摘要输入均不变）；「模型可见必落盘」不变量不受影响（它约束
  可见→落盘方向，不约束落盘→可见）。
- **UI 渲染不变**：流帧广播照旧；resume 回放 thinking 不在本件（落「不处理」）。

## 问题域

- 处理：StreamAccumulator 收集 thinking；message/attempt 两事件落已收内容；门收编；
  文档同变（THINKING-STREAM 契约 5 翻转 + AGENT-LOOP-DRIVER 流结算/attempt 段）。
- 不处理：
  - thinking 回传模型 / 进压缩摘要输入——投影白名单维持（THINKING-STREAM 既有
    「不回传」裁决延续）；
  - resume 回放 thinking 渲染——CLI 渲染面未来件；
  - thinking 截断/限额——不截断（用户诉求即「已获取内容存储下来」；WAL 体积代价
    如实接受，usage 行本就记录了量级）；
  - 历史 WAL 回填——加字段向前安全，旧事件无字段照常重放。

## 并发/一致性预算

- 无新并发面：收集在既有同步 `push` 内；落账在既有 append 点；无定时器/IO 新增。
- 数据量级：thinking 全文入 WAL（34K token ≈ 百 KB 级）——流式逐帧已进内存，落盘
  是顺序单写，接受；不因体积截断（截断=信息丢失）。

## 拆分

| 位置 | 改动 |
| --- | --- |
| packages/agent-loop/src/stream.ts | StreamAccumulator 收集 thinking-delta（`thinkingText` getter；`hasContent` 语义不变——空结算判定不含思考） |
| packages/agent-loop/src/step.ts | runAttempt：attempt 落账（appendAttemptLedger）带 `content`+`thinking` 增量；message 落账带 `thinking` |
| packages/core/session/src/types.ts | SessionEventData 两词条扩可选字段（编译期契约——审查处置 H1 补） |
| packages/core/session/src/gates.ts | 两词条新字段校验 |
| docs/THINKING-STREAM.md | 契约 5 翻转（落盘、仍不回传；预算/测试口径/验收清单同批改净） |
| docs/AGENT-LOOP-DRIVER.md | 流结算/attempt 落账描述同变 |
| docs/SESSION.md / docs/LLM-PI.md | 词条形状表 / 流帧语义句同变（审查处置补） |
| 测试 | stream/driver/gates/surface/idle-watchdog 五面（见测试口径） |

依赖方向不变。

## 实施顺序

单批次（无过渡态）：stream 收集 → 落账点 → 门 → 测试 → 文档 → 四门。

## 裁决

- **用户裁决（2026-09-20/21 多轮收敛）**：已收内容必须落盘——thinking 全路径 +
  attempt 已收正文；直接修复。
- **默认裁决（否决窗口）**：thinking 以 `assistant/message.thinking` 独立字段形态落盘
  （不进 ContentBlock 联合——避免投影/回传面被动扩大）；不回传、不进压缩输入、
  不截断、不回填历史。

## 测试口径

- **stream 单测**：thinking-delta 逐帧收集拼接；无思考 → thinkingText 空串；
  hasContent 不因思考非空而真（空结算判定回归）。
- **driver 症状回归**（用例名注明症状）：
  - 「34000 token 思考零落盘」形态：纯思考 + max-tokens → assistant/message 落
    `thinking` 全文、content []、stopReason max-tokens；
  - abort 纯思考 → assistant/attempt 落 `thinking`（error "aborted"）；
  - abort 有正文 → message{interrupted} 带 thinking + 正文；
  - 流错误（attempt）带部分正文 → assistant/attempt 落 `content` 增量 + thinking；
  - 正常 stop 有思考 → message.thinking 在场。
- **投影回归**：带 thinking 的 assistant/message 经 deriveMessages → SurfaceMessage
  无 thinking（请求体不变锚）。
- **gates 单测**：thinking 非 string → 门拒；attempt.content 非 blocks → 门拒；
  合法形状过门。
- **WAL 兼容**：旧事件（无字段）照常重放（既有用例不动即绿）。

## 验收清单

- [x] thinking 五路径落盘（stop/max-tokens/interrupted/attempt/正常）
- [x] attempt 已收正文（content 增量）落盘
- [x] 门收编 + 旧 WAL 兼容
- [x] 投影不变（不回传锚）
- [x] THINKING-STREAM 契约 5 翻转 + AGENT-LOOP-DRIVER 同变
- [x] 四门 + 覆盖率数字如实报告

## 审查处置（2026-09-21 代码收口前双路对抗审查）

- **H1 SessionEventData 类型联合未扩形（两审查同源）**：核实属实——运行时门已扩而编译期
  契约否认字段（`appendEvent` 的 unknown 参数让 typecheck 静默放行，「类型级丢失」判例）。
  处置：types.ts 两词条补 `thinking?`/`content?`/`thinking?` 三可选字段。
- **H2 THINKING-STREAM.md 四处旧口径残留**：核实属实——实现只翻了裁决节，契约 5 原文
  （「不进 jsonl/显式忽略」）、预算节（「内存零增长」）、测试口径（「全部事件不含哨兵」）、
  验收清单（「jsonl 零泄漏」）自相矛盾。处置：四处同批改净。
- **H3 attempt 的 tool_use 增量落盘零防线（假绿变异实证）**：变异「partialContent 丢
  toolUseBlocks」后 280 条全绿。处置：补「流错误前已收 tool-call-delta → attempt.content
  含聚积 tool_use」回归用例。
- **M1 SESSION.md 词条表未同变**：处置：两行补 `thinking?`/`content?`。
- **M2 LLM-PI.md「只广播不落账」残留**：处置：改「只透传；落账收集由 agent-loop 承担」。
- **L 级（全采纳）**：attempt 空 content 缺席口径断言（变异恒落 `content:[]` 曾全绿——
  empty-completion 用例钉）；看门狗超时入口 attempt.content 断言（idle-watchdog 既有用例
  扩）；surfaceToMessages 投影白名单直接锚（session 包自身，原先只靠端到端请求体锚）；
  纯思考+finish(stop) 空结算路径用例。
- **不另立项处置**：「流无 finish（P14）」与流错误汇入同一 appendAttemptLedger（变异
  M2/M3 传递性实证钉住），不加独立用例；`appendEvent` 泛型收窄（建议项）属既有
  全事件面模式，不在本件扩散。
- 核实无问题面（两审查一致）：五路径落盘完备（含看门狗/abort 赛跑分支）、投影/压缩/
  checkpoint/repair/childReport 无泄漏、门与 WAL/archive 兼容、哨兵翻转后不泄漏锚保留
  且增强、cancel 门控时序稳定。
