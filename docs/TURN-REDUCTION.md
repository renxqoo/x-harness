# 轮次收敛（Turn Reduction）：提升单轮工具并行度

> 状态：已收口（B0-B2 合入面经终审；B3 行为面经 3 任务配对验证证伪并回退——见 §5）
> 级别：**中**（跨模块：permission + 工具 + 系统提示词 + 测量面；无新外部契约）
> 依据：REPORT-glmf-round1.md §3.2——glm-5.3-flash 全量基准实测 41/42 轮串行单工具，输入 6.2M/任务（官方 claude-code ~2.2M），时延中位 20 分钟

## 0. 问题与证据

基准实测（21 任务事件流）：

- **每轮工具并行度 ≈ 1.0**：典型任务 42 轮 LLM 响应中 41 轮只调 1 个工具、0 轮并行。
- 每轮全历史重发 → 轮次是输入量与时延的公共乘数（77 轮/任务）。
- 输入×分数相关 −0.24：高轮次任务分数更低——串行探索是失控信号，不是深度。

**指令在场但模型不遵循**（base-prompt.ts:83-88 已有并行指令）。根因五条（审查 P9 补全）：

1. 指令埋在 Tool Use 列表第 2 条，权重不足，无示例；
2. **read 的工具 description 是单数措辞**（"Read a text file..."）——模型选工具时读的是它，权重远高于系统提示词条目；
3. `read` 一次一个文件（schema 单 path）——批量表达在协议层不顺手；
4. read 页脚 `Use offset=N to read on` 是逐文件串行续读邀请；
5. 无测量面——并行度不可观测，改进无法验证。

**Provider 能力预检（B0，审查 P9c）**：基线 0/42 并行与「GLM anthropic 端点不发多 tool_use 块」在数据上不可区分。B3 迭代提示词前先做廉价预检——取任一既有会话事件流确认多 tool_use 块可落账，或最小 curl 探针（一次请求要求读两个文件，看响应 content 是否出两个 tool_use）。若端点不支持：本方案降级为「read paths 批量 + 测量面」两项（lever A），lever B（同块多 tool_use）标注不可达并留档。

## 1. DESIGN

### 1.1 外部契约

**A. `read` 工具批量形态**（含安全面，审查 P1/P2/P3/P10/P11 钉死）：

```ts
// schema：path（既有单数）与 paths（新，Type.Array(Type.String(), {minItems:2, maxItems:8})）
// 互斥与双缺席：TypeBox 表达不了 XOR——判定落工具 execute 层（dispatch 先 schema 后 execute）：
//   {path, paths} 同给 → isError: "read accepts either path or paths, not both"
//   {} 双缺席          → isError: "read requires path or paths"
// paths 与 offset/limit 互斥（P2 裁决：批量=探索首屏；逐文件续读回单 path 形态——
//   批量后页脚不出现（见 P3 续读设计），组合无合法语义）→ isError 参数文案
// minItems=2：单文件用 path（避免 paths:[x] 的形状分叉——P10 裁决：paths 形态恒逐文件
//   <file path="..."> 包裹，path 形态保持既有裸输出，两形态刻意不同、各自稳定）
```

**Permission 裁决（P1，阻断项修复）**：`decide.ts` 的 `pathOf` 扩展——args 含 `paths` 数组时逐条目裁决，聚合规则：任一 deny → 整体 deny；任一 ask（界外）→ 整体 ask（grant.dir 取第一个界外条目的父目录）；全 allow 才 allow。`ask-summary.ts` 的 TARGET_KEYS 加 `"paths"`（summary 逐条列出）。deny 清单（`.env`/`.ssh` 等）对每条目完整生效。§2.3 加 `.env` 拒读与界外 ask 用例。

**批量聚合预算（P3）**：paths 形态总字节预算 = 单文件预算 50KB（BYTE_BUDGET 不变）——逐文件按剩余额度分配（均分或先到先得），预算耗尽的文件输出块内给行动型文案 `budget exhausted in this batch; re-read with single path to continue`。**不依赖调度层 maxToolResultChars 截断兜底**（那个截断无续读指引，模型不能自愈）。

**B. 系统提示词 + 工具 description 双面强化**（~~已实施并回退~~——见 §5：3 任务配对验证证伪；本节留档为否决记录）：

- `read` 工具 description 改复数：`"Read one or more text files within the workspace root. Pass paths: ["a", "b"] to read several files in one call."`（模型决策时真正读的文本）；
- base-prompt `## Tool Use` 节：并行指令提为首条 + 操作示例（read paths 批量 / 独立 read+grep 同块）+ 「先规划本轮要看什么，一次拿全」探索纪律；其余指令语义不变。

**C. 并行度测量面（P4/P6/P15 收敛为单一实现）**：

- **计数进 token-meter fold 状态**（删除 agent-loop 函数提案——同一事实一套实现；apps/cli print 模式经 `...usage` 摊开自动携带）；
- `applyEvent` 中计数位置：**先于 usage 样本门**（无 usage 的 assistant/message 也计数——错误路径的并行度恰是诊断目标），**只认 `assistant/message`**（`assistant/attempt` 的 tool_use 是截断重试的半成品，模型重发会在 message 再计，含 attempt 会双计）；
- 快照字段（P4 补全 + P15 命名避撞）：`toolUseCalls`（tool_use 块累计）+ `toolUseSteps`（含 ≥1 块的 assistant/message 数）+ `parallelSteps`（≥2 块的 message 数）——「step」措辞对齐仓库 turn=user 轮语义；派生指标 `avgToolUsePerStep = toolUseCalls / toolUseSteps` 由消费方计算（快照不存派生值——单一事实）。
- host-hub `get_session_stats` 既有 `toolCalls`（按 tool/call 事件）与 meter 的 `toolUseCalls`（按 assistant/message 块）口径不同：前者含重试派发、后者是模型意图面——TOOLBOX/TOKEN-METER 文档各钉一句。

### 1.2 问题域

**处理**：read 批量（含 permission 聚合裁决 + 聚合预算）；工具 description + 提示词双面强化；meter 快照并行度三字段。

**不处理**（归属）：

- bash/edit/write/grep 批量形态——bash 天然 `&&` 复合（description 已教），edit/write 依赖语义，grep 价值低；按测量数据再裁；
- **bash 串行探查治理**（报告 §3.2 第 3 项的另一半）——独立立项（它需要输出截断/摘要基建，与「工具结果截断」合并做更顺）；
- 强制并行（协议层改写模型输出）——越权，不做；
- 工具结果截断——独立立项（见上）。

### 1.3 并发与性能预算

- `paths` 串行执行（fs 快），8 文件聚合预算 50KB 上界（P3：预算在工具层自截，不靠调度层）；
- meter 计数 O(1)/事件（三个标量）；
- 提示词/description 变更使既有缓存前缀失效——**一次性部署成本**（P14 修正论证：base 段任何字符变化都使全部前缀失效，与增量大小无关；会话内静态，跨会话本就少复用），部署后首个会话起前缀重新稳定。

### 1.4 方向性裁决（含审查修正）

| 裁决 | 选择 | 理由 |
|---|---|---|
| 批量语义：部分成功 vs 全有全无 | **部分成功**（单文件失败仅该块 isError 文案） | 逐文件报错信息量大；整体 isError 仅当全部失败 |
| paths 上限与预算 | **8 文件 / 聚合 50KB** | 聚合预算防单轮巨量回灌（P3） |
| paths × offset/limit | **互斥拒绝** | 批量=探索首屏；续读回单 path（P2） |
| paths 输出形状 | **恒逐文件 `<file>` 包裹**（与单 path 裸输出刻意不同） | 两形态各自稳定，不追求跨形状「等价」（P10） |
| 测量实现 | **单一：token-meter fold** | 同一事实一套实现（P6） |
| 验收主指标 | **turns/task 与 input/task（配对比较）** | lever A 成功会压低 avgToolUsePerStep，它只度量 lever B——降为诊断指标（P5） |

## 2. IMPLEMENTATION

### 2.1 逐模块裁决表

| 模块 | 裁决 | 说明 |
|---|---|---|
| **packages/permission/src/decide.ts** | **修改（P1）** | pathOf 扩展 paths 数组逐条裁决 + 聚合规则 |
| **packages/permission/src/ask-summary.ts** | **修改（P1）** | TARGET_KEYS + "paths" |
| packages/permission/src/__test__ | 新增 | paths 含 .env → deny；界外条目 → ask（grant.dir 正确）；混合 allow+deny → 整体 deny |
| packages/tool-read/src/read.ts | 修改 | paths schema（description 复数措辞已回退——见 §5） + execute 互斥/双缺席/offset 互斥 + 聚合预算 + 逐文件块 |
| packages/tool-read/src/__test__ | 改写+新增 | §2.3 契约矩阵全量 |
| packages/harness/src/base-prompt.ts | 修改 | Tool Use 节首条+示例+探索纪律 |
| packages/token-meter/src/fold.ts | 修改 | applyEvent 计数（先于 usage 门、只认 message）+ 快照三字段 |
| packages/token-meter/src/__test__ + apps/cli 两个 fixture + token-analytics 镜像断言 | 改写 | 必填新字段补全（P13：cli 非零改动，是机械补字段） |
| **packages/e2e**（agent-journey 装配） | **修改（P12）** | world 补装 tokenMeterPlugin；新增两旅程（§2.3 e2e） |
| docs/TOOLBOX.md §2 / TOKEN-METER.md | 同步 | P16：read 文档在 TOOLBOX.md 非 TOOL-READ.md；口径关系钉句 |

### 2.2 实施顺序（B0 预检 + 3 批）

- **B0 能力预检**（P9c，半小时）：既有会话事件流 grep 多 tool_use；或 curl 探针。结果落本文件收口节。
- **B1 测量**：meter 三字段 + 全部 fixture 补齐 + 测试。
- **B2 read 批量 + permission**：read.ts + decide.ts + ask-summary.ts + 测试矩阵 + TOOLBOX.md。
- **B3 行为面**：description + base-prompt + e2e 两旅程 + 独立对抗审查。

每批四门全绿独立提交，提交信息引用本文件节号。

### 2.3 验证口径

**契约级**：
- read：`{paths:[a,b]}` → 两 `<file>` 块；`{path:a}` 旧形态输出不变（回归）；`{path,paths}` / `{}` / `{paths:[]}`（minItems）/ `{paths:9项}`（maxItems）/ `{paths,[offset]}` → 各自 isError 文案；部分成功（a 在 b 不在）→ a 内容块 + b 错误块、整体非 isError；全失败 → 整体 isError；预算耗尽块给续读指引文案；
- permission：paths 混入 `.env` → deny（文案含该条目）；paths 含界外 → ask 且 grant.dir 正确；全界内 → allow；
- meter（表驱动：0/1/2/3 块矩阵）：`toolUseCalls`=Σ块、`toolUseSteps`=含块消息数、`parallelSteps`=≥2块消息数；**attempt 带 tool_use 不计数**（构造 attempt 含块 → 三字段不动）；无 usage 的 message 计数照常。

**e2e**（agent-journey world 补装 meter，P12）：
- 旅程 1：scripted adapter 单响应 yield 两个 tool-call-delta（不同 index）→ 两工具都派发、结果配对、meter.toolUseCalls=2 / parallelSteps=1；
- 旅程 2：真 read 工具 `paths:[两文件]` → 输出两块、permission 放行。

**B3 后行为验证**（P5 修正）：固定 3 任务配对重跑（与基线同任务同 judge），主指标 **turns/task 与 input/task**（基线数字进用例）；`avgToolUsePerStep` 降为诊断指标；分数门如实标注「n=3 无统计效力，仅回归监控（judge 偏移 ±1~3）」。

### 2.4 对抗审查安排

- B1+B2 合并一轮审（机械性高）；
- B3 独立审（行为面）：审 diff + 本方案 §1.1B/§0 根因五条，指令「假设这些措辞无效或有害，列坏法」。

## 3. 风险与回退

- 提示词+description 仍可能不改变模型行为——B0 先排除端点能力问题；B3 后 3 任务快速基准无效则迭代措辞（指令无害不回退）；
- paths 滥用读巨量——聚合预算 50KB 硬界 + maxItems 8；
- 回退 = revert 对应批次（无持久化形状变化）。

## 4. 验收清单

- [ ] B0 预检结果落档（端点多 tool_use 能力确认/排除）
- [ ] 四门全绿，覆盖率只升不降
- [ ] permission 聚合裁决用例（.env deny / 界外 ask / 混合）全绿
- [ ] read 契约矩阵全绿（§2.3 逐条）
- [ ] meter 三字段 + 表驱动 + attempt 排除用例 + e2e 两旅程
- [ ] B3 diff 过独立对抗审查
- [ ] **行为验证（3 任务配对）**：turns/task 与 input/task 相对基线下降（主指标）；avgToolUsePerStep 作诊断；分数门标注无统计效力
- [ ] TOOLBOX.md / TOKEN-METER.md 同步（含两 toolCalls 口径关系句）
- [ ] 假绿抽查：无 skip、无断言弱化

## 5. 收口记录

### 3 任务配对验证与 B3 回退（2026-09-27）

配对验证（同任务/同模型/同 judge，worktree 分支 vs 基线）：

| 任务 | 轮次（基线→验证）| 输入 | 并行度 |
|---|---|---|---|
| default-create-in-idp-checkbox | 42→46（+10%）| 1.6M→2.3M（+46%）| 9/45 步 avg 1.24 |
| consistent-csrf-across-toggle | 73→187（**+156%**）| 5.5M→17.1M（**+212%**）| 20/186 步 avg 1.11 |
| lifecycle-workflow-webhooks | 243→267（+10%）| 30.4M→38.2M（+26%）| 34/266 步 avg 1.13 |
| **合计** | **+40%** | **+54%** | |

**证伪结论**：并行度确实起来了（avg 1.0→1.1+，parallelSteps 9-34——meter 三字段
工作正常），但批量意图走成了串行 bash 连跑（csrf 任务前 40 调用 = bash×35，每条
`cd $REPO && grep/sed …`）；read paths 零调用。根因：**批量探索主场景是跨目录模式
搜索**（grep -rn + sed 窗口），read paths 只覆盖已知确切路径的多文件整读——出口
错位；bash avoid-grep 清单与批量指令相互干扰未生效（验证轮 bash 内 grep 89 次
vs 基线 30）。

**回退范围**（09a7ef1/a6fd9f2）：base-prompt Tool Use 节改写、bash description
avoid-grep、grep description 引导句、read description 批量措辞——提示词面对 main
最终仅保留用户裁决的一条：`When searching, use the grep tool instead of shell
commands whenever possible.`（Tool Use 首条，1557ecd）。

**保留面**（无行为副作用，终审通过）：B1 meter 三字段、B2 read paths 协议 +
permission 聚合裁决、e2e 双旅程。

**后续纪律**：B3 类行为面改动必须先过 5+ 任务样本配对验证再合入；批量探索的
对位出口（grep 工具多 pattern/多路径批量形态）另立项。

### B0 能力预检结果（2026-09-27）

最小探针（glm-5.3-flash，anthropic 端点非流式，两工具 + 明确指令）：

```
tool_use 块数: 2 | 名称: ['read', 'grep'] | stop_reason: tool_use
```

**结论：端点原生支持单响应多 tool_use 块，lever B（同块并行）可达**——基线 0/42 并行
确认为 agent 侧引导问题（指令位置/描述措辞/协议顺手性），非 provider 能力缺失。
B3 提示词迭代不是盲调。
