# 子代理长内容回传通道（件15）：cap 同源 + 文件中转引导 + 截断抢救附注 + summary 承诺兑现

> 状态：**已实施（批 1-4 落地；四门 + e2e 默认门全绿；对抗审查见 §6 处置注记）**
> 级别：中（agent-delegation 包内改 4 文件 + 新 1 文件 + 测试；harness delegationKit 签名一行放宽（D5）；CLI/host-hub 零改动）
> 关联：docs/AGENT-DELEGATION.md（件13——§2.1 参数面/§2.2 预算/修订B 逐字纪律）；
> docs/AGENT-MESSAGE.md（通知载体）；docs/TRUNCATED-TOOL-RESCUE.md（agentTruncatedTool
> 抢救机制——本件消费其 waterfall，不扩其抢救表）；docs/TASKS.md（件14 task 动词，非本件面）。

## 0. 缺陷定义（生产症状 → 根因）

症状：子 agent 回传长内容被**截断**或**拒绝**后自救路径残缺——全截断 case 有续写自救
（agent-continuation ≤3 次，指令只引导拆小块、不提文件中转），超限/超次/混合 case 以不完整
报告收轮；全链路无一处引导模型走向文件中转这个正解；summary 元数据则被承诺「截断不拒」
却实际被拒。

四条失败路径全量分析：

### 路径 A：主动消息 `agent_message{to:"main"}`（子→父回传主力）

```
子模型生成 tool_use(message=超长文本)
  ├─ A1 生成中撞 provider 输出 token 限 → 参数被截断 → JSON.parse 失败
  │     → TRUNCATED_TOOL_MESSAGE（agent-loop/src/tool-calls.ts:39）：
  │       "Re-issue the call; for large file writes, split the content into smaller pieces"
  │     → 调用不执行；引导只有 split，无文件中转；对 message 类负载 "Re-issue" 是错误指引
  │       （重发只会再截断一次）；后续自救在场但不完整：agent-continuation 续写指令
  │       （OUTPUT_CONTINUATION_INSTRUCTION）同样只引导拆分——文件中转无人提及
  │
  └─ A2 参数完整但 >34000 字符 → TypeBox pattern `^[\s\S]{0,34000}$` 违规
        → dispatch 拒绝（packages/core/tools/src/dispatch.ts:171）
        → 报错 = TypeBox 默认错误文案——实测（0.34.52 errors/function.js:117，
          全仓无 SetErrorFunction 覆盖）pattern 报错含 pattern 原文：
          "Expected string to match '^[\s\S]{0,34000}$'"——上限数字在场但埋在
          正则语法里，可读性差而非不可见
          + 违规回显（回显本身被 formatArgsEcho 截到 2000 字符，validate.ts:65）
        → 模型看不到自己完整内容，也得不到「该怎么拆/写文件」的引导
```

通过校验后无截断：`deliverToMain`（verbs.ts:98）包装 `<cross-session-message>` steer 进父会话；
父封存 → `not-found:main`。

### 路径 B：完成报告（系统推送）

```
子 idle 边沿 → childReport 读子 WAL 末 turn/end + 本轮 assistant 全文
  → summaryLines(summary, reportCap=34000)（notify.ts:14-17）
  ├─ 超 34000 → 截断 + 尾注 "[report truncated at 34000 chars;
  │     use agent_message to ask the agent for specifics]"
  │     → 引导的是「追问」；但追问回复同受 A2 的 34000 pattern——被截断的报告残余
  │       恰恰是最需要超长回复的内容，闭环天生脆弱
  ├─ 子撞 max-tokens 无 assistant 文本 → "no summary"（notify.ts:119）
  ├─ 子会话缺档 → session-archived 占位（无报告）
  └─ tearing-down / 父封存窗口 → 通知丢弃
```

### 路径 C：父→子追问（与 A 同限）

父用 `agent_message` 向子追问细节——message 参数同受 34000 pattern；spawn 的 `prompt`
无上限（`Type.String` 裸串，tools.ts:46）但撞输出 token 限时同样落入 A1 的错误指引。

### 路径 D：summary 元数据的承诺违约（D7）

```
schema（tools.ts:61-63）：summary maxLength:500 —— dispatch 先校验后执行（dispatch.ts:171）
  → 501+ 字符 summary 在进 verb 前被拒，整个调用失败——合法的 message 载体陪葬
description 承诺 "Truncated to 500 characters rather than rejected" —— 与 schema 直接矛盾
verbs.ts:66-70 echoSummary 的 slice(0,500) 截断 + "…" 分支 → 结构性不可达（死代码）
```

三层矛盾：① schema 拒绝 vs description 承诺截断——模型读到承诺、写了 600 字符、被拒，
被承诺不会发生的事发生了；② echoSummary 只挂 `notifyWhenIdle` 路径（verbs.ts:62）——
三条投递路径（deliverToMain/deliverToRow/crossFallback）全部不回显 summary，docs §2.1
「等价物=结果回显」承诺只在三分之一路径兑现；③ 矛盾继承自规格源（:167 schema
maxLength 200 + description "Truncated to 200 rather than rejected" 的同款自相矛盾，
规格「细节矛盾」注记只登记了 message 必填那条，本仓抄形态改数字带入了矛盾）。

**方向原则（与 D6 相反，且相反是有原则的）**：message 是真实负载——超限是真实预算问题，
schema 硬上限拒绝是**保护**；summary 是装饰性元数据（不传输、不落对端、仅发方回显）——
超长拒绝是**误伤**（一条 501 字符 label 否决整个调用的真实投递）。拒绝该拒绝的，
吸收不该拒绝的。

### 漂移与脱钩（工程债）

| # | 问题 | 位置 |
| --- | --- | --- |
| P1 | **文件中转零引导**：docs §13 裁决「复用现有 write/read 不建专通道」（AGENT-DELEGATION.md:470），但模型可见的任何面（工具 description、参数 description、截断尾注、违规报错）都不提「写文件让对端 read」——裁决对模型不可见，等于没有这条路 | descriptions.ts 全文 / notify.ts:16 / tools.ts:57 |
| P2 | **超限拒绝无自救指引**：A2 的报错含上限但埋在正则语法里（`to match '^[\s\S]{0,34000}$'`）——可读性差而非不可见；且无「该怎么拆/写文件」引导，对比 TRUNCATED_TOOL_MESSAGE 至少有 split 指引——处置面 = D6（maxLength 载体，报错为直接数字） | dispatch.ts:171-174 / validate.ts:59 |
| P3 | **两处 34000 无单一真相**：reportCap 可配置（DelegationOptions，缺省 34_000，plugin.ts:36），message 上限硬编码字面量（tools.ts:58）——宿主调低 reportCap 后两面脱钩，闭环断；且现状 `delegationKit` 签名窄化为 `{ agentsDirs }`（harness/src/index.ts:198），宿主经装配入口根本传不了 reportCap——P3 的宿主场景当前不可达（D5） | plugin.ts:36 vs tools.ts:58 / harness/src/index.ts:198 |
| P4 | **文档漂移**：docs §2.1 写 `^[\s\S]{0,3000}$`、§13 裁决行自写「message 300 上限」、规格源写 300、代码 34000（commit 5fdaece 单点改码未回写文档）——四处口径（文档内部 §2.1 与 §13 也不一致） | AGENT-DELEGATION.md:36 / :470 / claude-tool 规格源:175 |
| P5 | **输出 token 限是更先撞的暗墙**：模型即使知道 34000 上限，生成超长 message 参数先撞 provider 输出限；base 文案的 "Re-issue the call" 对此是错误指引 | tool-calls.ts:39 |
| P6 | **截断尾注引导的追问依赖子可寻址**：父进程重启 + 纯内存部署（无 jsonl）时 reviveByName 缺席 → not-found，追问闭环断 | verbs.ts:79-83（挂账，非本件修） |
| P7 | **summary 承诺违约**（路径 D）：schema 拒绝 vs description 承诺截断；echoSummary 死代码 + 回显路径覆盖 1/3——处置面 = D7 | tools.ts:61-63 / verbs.ts:39,62,66-70 |

## 1. 外部契约（终态）

| 面 | 现状 | 终态 |
| --- | --- | --- |
| `agent_message.message` 上限 | pattern `^[\s\S]{0,34000}$` 硬编码 | `maxLength: N`，**N = 该插件实例的 reportCap**（单旋钮恒等，D1）；载体弃 pattern 用 maxLength——`^[\s\S]{0,N}$` 只做长度约束（`[\s\S]` 收一切字符含换行），与 `maxLength: N` 语义严格等价（UTF-16 code units 同口径），而 TypeBox maxLength 报错是直接数字（`Expected string length less or equal to N`）、pattern 报错把数字埋在正则语法里——对模型可解析性更强，P2 可读性改进（D6） |
| `agent_message.summary` | schema `maxLength: 500` 拒绝超长——与 description 截断承诺矛盾（P7/路径 D） | **schema 去 maxLength**（`Type.String({ description })`），截断语义由 verb 层 `SUMMARY_CAP=500` 兑现；description 原文不动（其承诺从此为真）；`echoSummary` 挪到 `message()` 统一出口——三条投递路径全覆盖 + 空串守卫（D7） |
| `message` 参数 description | 规格逐字，无长度策略指引 | 追加一句**数字无关**文件中转指引（本仓扩展；工具级三段 description 维持逐字不动——contract.test 逐字比对只针对工具级常量，参数面本就只做形状对账，D2） |
| 报告截断尾注 | `use agent_message to ask the agent for specifics` | 追加文件中转半句（见 §2 文案） |
| 截断 tool_use 配对文案 | base 通用文案对 message 类负载引导错误 | **base 不动**（agent-loop 零改动）；delegation 经 `agentTruncatedTool` waterfall 追加 **note-only 抢救附注**（既有机制，tool-write 同款链式纪律；不写 sidecar、零副作用） |
| `agent_spawn.prompt` | 无上限（维持不设）；截断时无指引 | 同款 note 覆盖（D3）：长任务简报走文件 + 短 prompt 引路径 |
| harness/CLI/host-hub | `delegationKit` 签名 `(o: { agentsDirs })` 窄化——宿主无传 reportCap 的类型入口 | `delegationKit` 签名放宽为 `(o: DelegationOptions)` 透传（D5）：agentsDirs 必收不变，CLI 调用点（build-world.ts:164）零改动，host-hub 不经此装配 |

**不变量（恒等的结构意义）**：「报告截断 → agent_message 追问 → 追问回复」闭环——追问回复
的可用空间恒 ≥ 被截断的报告残余；宿主调 reportCap，schema 门与截断门同步移动，闭环不因
配置脱钩（P3 根治）。恒等的生效前提：父追问的是**残余细节**而非全量重发（后者同受 N 限）
——由尾注文案（specifics / 文件中转半句）引导保障，是文案层固有限制而非结构缺陷（§6 预答）。

**明确不处理**（问题域边界）：
- message 前缀 sidecar 物化（write 式抢救的 message 版）——message 无自然 path 字段，
  需发明落盘约定，价值/成本比不足，挂账 §7；
- TRUNCATED_TOOL_MESSAGE base 文案不改——note 精确补位，agent-loop 零爆炸半径；
- mailbox 信封长度门——本机文件协议天然无界；
- 规格源文档（claude-tool）的 300/200 表述——外部参照不动（summary 矛盾系规格自带，
  本仓按 description 语义裁决，差异落档修订D）；
- P6（纯内存部署追问落空）——依赖 archive 部署形态，挂账 §7。

## 2. 实现设计（文件级）

```
packages/agent-delegation/src/tools.ts        messageSchema 移入 delegationTools() 工厂，
                                              message 上限改 maxLength 按注入 reportCap 插值
                                              （D6）；summary 去 maxLength（D7）；ToolDeps
                                              + reportCap: number；message description 追加
                                              中转句（数字无关）
packages/agent-delegation/src/verbs.ts        echoSummary 挪到 message() 统一出口（三路径
                                              全覆盖）+ 空串守卫（D7）；notifyWhenIdle 原调用
                                              点撤除（统一出口后冗余）
packages/agent-delegation/src/plugin.ts       delegationTools({...}) 注入 limits.reportCap
                                              （validateOptions 已算好，一行）；apply 内挂
                                              rescue-note（同插件内，无新装配面）
packages/agent-delegation/src/notify.ts       summaryLines 尾注追加文件中转半句
packages/agent-delegation/src/rescue-note.ts  新文件：ctx.on(agentTruncatedTool)——
                                              next() 结果非空即透传（让位），name ∈
                                              {agent_message, agent_spawn} → 返回 note；
                                              纯指引零副作用
packages/harness/src/index.ts                 delegationKit 签名放宽 (o: DelegationOptions)
                                              透传（D5——一行；CLI 调用点零改动）
```

**rescue-note 设计要点**（对齐 tool-write rescue-plugin.ts 的链式纪律，减去全部物化面）：

- waterfall 消费者：`next(payload)` 先行，**结果非空即透传（让位）**——与 tool-write
  rescue-plugin.ts:86-88 同款纪律；链序 = root 层装配注册序（core/context
  insertByLayerDepth），两件白名单不相交（write/edit vs agent_message/agent_spawn）
  实际无碰撞，让位是防御性纪律（§6 盯装配序敏感）；
- `payload.signal.aborted` → 透传 downstream（abort 竞态不发指引）；
- `payload.name` 白名单命中（agent_message / agent_spawn，D3）才应答，其余 undefined；
- 不 import extractStringField / admitSession / permission——不提取前缀、不写盘；
  模型需要的是**换策略**不是续写半截；
- note 形状门在内核已有（note 非空串；垃圾忽略走 base 文案）。

**summary 承诺兑现设计（D7）**：

- `SUMMARY_CAP = 500` 保持 verbs.ts 单一定义（回显截断单一真相）；description 文案中的
  "500" 是规格体 prose（参数面非逐字锚），与 SUMMARY_CAP 双写接受——同步靠 contract.test
  锚词断言（`Truncated to 500`）钉住，不引入构造期插值；
- `echoSummary` 出口统一：`message()` 对所有 ok 结果包装回显（`summary === undefined ||
  summary === ""` 跳过）；`notifyWhenIdle` 原调用点（verbs.ts:62）撤除；
- 兜底语义：不拒绝、回显截断——元数据不否决真实负载（路径 D 方向原则）；
- **服务面影响声明**：`message()` 动词的第二个消费方是 plugin.ts 的 delegationView 服务面
  （host-hub subagent-steer 直调，不经工具 dispatch）——回显归动词层则服务面同享该语义；
  hub 调用不传 summary 字段，实际返回文本零变化，落档说明（备选：回显放 tools.ts execute
  包装只及模型可见面——两层各持一半回显逻辑，弃）。

### 文案（数字无关，实施批可微调措辞不变形）

- **message 参数 description 追加**：`For long content, write it to a file and send a short message with the file path instead of inlining it.`
- **报告截断尾注**：`[report truncated at ${cap} chars; use agent_message to ask the agent for specifics, or have it write the full content to a file]`
- **rescue note（message）**：`Your agent_message was cut off mid-arguments and NOT delivered (your own view of the arguments renders as {}). Do not re-send it from memory. For long content: send it in shorter messages, or write it to a file and send a short message with the file path.`
- **rescue note（spawn）**：`The agent_spawn call was cut off and NOT executed. For a long task brief, write it to a file and pass a short prompt that references the file path.`

## 3. 测试计划

**单测（agent-delegation 包）**：

| 组 | 用例 |
| --- | --- |
| contract.test | maxLength 随注入 reportCap 变化（缺省 34000 + 自定义 1000 双断言；:72 既有 pattern 断言同批改 maxLength）；summary `maxLength` 断言改 **缺席** + `Truncated to 500` 锚词断言（钉 prose-代码数字同步）；message description 含中转锚词（`file`/`path` 词边界正则）；**工具级三段 description 逐字断言不动**（防顺手破坏修订B）；参数面其余形状断言维持 |
| verbs/delegation | summary 承诺兑现（D7）：601 字符 summary → 投递成功 + 回显含前 500 字符 + `…`；summary 空串 → 无回显附注；三条投递路径（main/子行/跨进程）回显全覆盖断言 |
| report-delivery.test | :48 原断言保留 + 尾注文件中转半句断言 |
| rescue-note 新组 | agent_message/agent_spawn 名命中 → note 在场且含锚词（file path / cut off）；其他工具名 → undefined；downstream 已有 note → 让位不覆盖；abort → 透传；装配后 agentTruncatedTool 派发可见（waterfall 注册面） |

**e2e（新增长内容旅程，进默认门——packages/e2e/src/main.ts 旅程序列 +1 行）**：新独立
旅程文件（不改 delegation-journey.ts——其装配不含 write 工具，脚本②的落盘断言需要
**write 工具及授权面装配**）→ 装配 `reportCap: 120`（耦合面即测试面，D4——maxLength
同步变 120）→ 子脚本①发超长 `agent_message`（完整合法 JSON、长度超 120）→ 断言 schema
拒绝路径回显**含具体数字 120**（断言载体无关——pattern 载体下数字埋在正则原文里、
maxLength 载体下是直接数字，两种载体都通过）→ 子脚本②改为 write 文件 + 短 message
带路径 → 断言父 WAL 出现 `<cross-session-message>` 含路径、文件在盘 → 子报告超 cap →
父通知含截断尾注两半句。装置复用 delegation-journey.ts 的假适配器脚本桶形态（scripts
Map 按 model 分桶）。装配清单 = delegation-journey.ts 基础上补齐：**createTaskToolsPlugin()
（硬依赖——delegation inject 含 task-tools，缺即装配 throw，非静默降级）** + write 插件面
（createWritePlugin + gate/observed/ExecEnv，root 指旅程临时目录——脚本②落盘断言的
PathGate 边界）。

**门禁**：四门全绿（typecheck / lint 0-0 / build / test）+ 覆盖率只升不降 + 独立会话
对抗审查（指令：对照本件 §1 契约表审 diff，假设实现与契约有偏差）。

## 4. 实施批次（每批独立提交、可独立回滚）

| 批 | 内容 | 验证 |
| --- | --- | --- |
| 1 | schema 载体双裁决落地：tools.ts 工厂化（message maxLength=D6 + summary 去 maxLength=D7）+ plugin.ts 注入 + delegationKit 签名放宽（D5）+ contract.test 改造 | 四门（机械改动先行，验证工厂化不破装配） |
| 2 | summary 回显兑现（D7）：echoSummary 统一出口 + 空串守卫 + verbs/delegation 用例；引导面：message description + 尾注 + report-delivery.test | 四门 |
| 3 | rescue-note：新文件 + 挂接 + 用例组 | 四门 |
| 4 | e2e 旅程 + 文档收口：AGENT-DELEGATION §2.1 改 maxLength = reportCap 同源表述 + summary 截断口径（P4/P7 清账，四处归一）+ 修订D 节落档（恒等裁决 / maxLength 载体裁决 / summary 承诺兑现裁决 / 参数 description 本仓扩展例外 / note-only 抢救注记进 TRUNCATED-TOOL-RESCUE 层 2 抢救表 / 300-3000-34000 漂移史）；本件状态推进「已实施」 | 四门 + e2e 默认门 + 对抗审查 |

## 5. 裁决记录

| # | 裁决点 | 裁决 | 理由 |
| --- | --- | --- | --- |
| D1 | message 上限 ≡ reportCap 恒等（单旋钮），不设独立 messageCap | **通过** | 两者唯一语义关联就是截断-追问闭环；拆双旋钮 = 文档/校验/测试翻倍，换来的解耦无真实场景（「要长报告但要短消息」不成立） |
| D2 | 参数 description 增文件中转句（工具级三段维持逐字） | **通过** | contract.test 的逐字对账只覆盖工具级常量；参数面是形状+锚词对账，本仓扩展合法；工具级动一个字都会破逐字锚；规格源自身 :175 写「长内容应拆分或改用文件中转」——扩展方向有外部参照背书 |
| D3 | rescue note 覆盖 agent_message + agent_spawn | **通过** | 同构负载（长文本入参、撞输出限同形态），filter 白名单一行之差 |
| D4 | e2e 用小 cap（120）驱动闭环 | **通过** | 真实 34000 旅程不可测（生成侧先撞 token 限）；小 cap 把耦合面变成测试面（单测面 delegation.test.ts 已有 reportCap 10 先例） |
| D5 | delegationKit 签名放宽为 `(o: DelegationOptions)` 透传 | **通过** | 现状签名窄化 `{ agentsDirs }`（harness/src/index.ts:198），宿主经装配入口传不了 reportCap——不放宽则 P3 只闭环插件半边、宿主场景仍不可达；agentsDirs 必收不变，CLI 调用点零改动；同一事实一套接口，不留双轨 |
| D6 | message 上限载体弃 pattern 用 maxLength | **通过** | `^[\s\S]{0,N}$` 与 `maxLength: N` 语义严格等价（该 pattern 只做长度约束、`[\s\S]` 收一切字符，UTF-16 code units 同口径）；TypeBox maxLength 报错是直接数字（`Expected string length less or equal to N`，0.34.52 errors/function.js:113），pattern 报错把数字埋在正则语法里（`to match '^[\s\S]{0,N}$'`，:117）——对模型可解析性更强，P2 可读性改进而非根治不可见；规格源 pattern 形态差异落档修订D |
| D7 | summary 去 schema maxLength，verb 层兑现截断承诺 + echoSummary 统一出口 | **通过（用户裁决纳入）** | summary 是装饰性元数据（不传输不落对端仅发方回显）——超长拒绝是误伤（501 字符 label 否决整个调用的真实投递）；description 已承诺截断语义，schema 去限让承诺为真；方向与 D6 相反是原则性差异（真实负载保护性拒绝 vs 元数据吸收性截断）；echoSummary 三路径全覆盖兑现 docs §2.1「等价物=结果回显」 |

## 6. 对抗审查处置（两路并行，已完成）

路B（并发/生命周期/资源面）11 维度：核心机制 7 维（waterfall 生命周期/链序共存/abort 竞态/
reportCap 单源/echoSummary 无双重包装/双重 dispose 幂等/文案面）核验通过；偏差 #1 e2e
断言失败不回卷 ctx（已修——finally 补 ctx.dispose，delegation-journey 同病顺手修）/
#2 桶耗尽无守卫（已修——双守卫 no-script-bucket/bucket-empty）/#3 死导入（已删）/
#4 deepFreeze 冻 AbortSignal（挂账 §7——非本件引入，归 core/context）。

## 6b. 对抗审查预案（历史——批 4 收口前制定）

- 路 A（契约面）：schema 工厂化后 reportCap 注入链是否单源（装配 vs 测试装置双真相？）；
  逐字锚是否真的未被波及；note 让位链与 tool-write 抢救件的共存（装配序敏感性——白名单
  不相交，碰撞应为结构性不可能，若见碰撞即装配序 bug）；D1 恒等生效前提（父追问残余
  而非全量重发）由文案保障的边界；D6 等价性在换行/代理对/空串边界不破；D7 回显统一后
  notifyWhenIdle 分支的行为等价（无双重回显、无遗漏）。
- 路 B（生命周期面）：rescue-note 消费者的 dispose 回卷；abort 竞态下 note 泄漏；
  maxLength 插值对 reportCap 垃圾值（0/负/非整数）的防御（validateOptions 已挡，确认边界）。

## 7. 不处理（挂账）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| message 前缀 sidecar 物化 | 无自然 path 字段；需发明落盘约定 | 后续（若 note-only 指引实测不足再立项） |
| TRUNCATED_TOOL_MESSAGE base 文案 | note 补位已够；动 base 影响全工具面 | 不改（本件内裁定） |
| P6 纯内存部署追问落空 | 依赖 archive 部署形态 | 部署纪律（文档已声明） |
| bash heredoc 抢救 | 沿 TRUNCATED-TOOL-RESCUE v2 挂账 | 既有挂账 |
| dispatchWaterfall 无条件 deepFreeze 冻结 AbortSignal（create-context.ts:457）——node 运行时下 turn 中 dispose→cancel→abort 抛 TypeError（bun 全绿依赖单运行时；件15 新增第二个 signal-bearing 消费者扩大暴露面但行为不变，审查 B#4） | 非本件引入（tool-write 抢救件先在）；候选修法：freeze 降 shellFreeze / deepFreeze 跳过 AbortSignal 子树 / 仓声明 bun-only + CI 钉运行时 | core/context 后续件 |

## 8. 验收清单

- [x] 批 1-4 全部四门绿，独立提交可回滚（批1 267ddb1 / 批2 / 批3 / 批4 各自独立提交）
- [x] contract.test：maxLength 双断言（34000/1000）绿；summary maxLength 缺席 + 'Truncated to 500' 锚词绿；工具级逐字锚未动
- [x] delegationKit 签名透传 DelegationOptions（D5）
- [x] D7 用例绿（summary-echo.test.ts：601 字符截断+省略号 / 空串守卫 / main 通道覆盖）
- [x] rescue-note 用例组全绿（rescue-note.test.ts 六用例——含装配后 waterfall 派发可见；让位用例曾抓到实现缺 downstream 非空判断，已修
- [x] e2e 长内容旅程进默认门绿（long-content-journey.ts：'Expected string length less or equal to 120' 数字回显 → relay-payload.md 落盘 → 父 WAL 含 <cross-session-message> 路径 → 尾注两半句 + truncated at 120）
- [x] AGENT-DELEGATION §2.1/§13 口径归一 + §18 修订D 落档；本件状态「已实施」
- [ ] 对抗审查偏差清单清零（修掉或引用本件已裁决节号）
- [ ] 覆盖率行/语句/函数 ≥90、分支 ≥85 只升不降，数字如实报告
