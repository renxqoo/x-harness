# BATCH3 方案——commands 插件（借件 deepseek-harness：内核命令注册面 + kit 自声明）

状态机：**定稿**（草稿 → 两路方案审查 5H/10M/9L 全处置 → **[当前]** → 已实施 → 已核销）。借件迁移：交付物是**新能力**（命令注册
面下沉内核、kit 自声明命令），借 repo-migration-e2e-v2 的文档结构、存量审计纪律与
装置适配记录；行为规格基线 = 本仓 hub 现状（旧实现行为是唯一规格），deepseek-harness
的 `packages/interaction/commands` + `packages/compaction/command-compact` 是架构参照
（不是行为规格——凡与本仓现状冲突处以本仓现状为准，逐条落 §4 差异表）。

## 1. 背景与裁决（对话已定）

现状：`/compact` 词法私有在 hub（`compact-invocation.ts`），执行特判在
`runManualCompact`（streaming/compacting 双前置 + inflight 登记 + 手工应答）。参照系
（deepseek-harness）已验证的形态：命令注册表插件（`CommandRuntime`：register/list/
find/execute + `command/run`/`command/done` log-only 配对事件，**不开 turn**）+ kit
自声明（`command-compact` 独立包 `inject:['commands','compaction']` 注册 `/compact`，
handler 调 `compactNow` seam）。采用**参照系的 turn 外执行模型**（弃「步内执行」——
agent-loop 零改动，命令不进模型上下文由 log-only 天然保证）。

## 2. 外部契约（内核 commands 包）

### 2.1 新包 `packages/commands`

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | CommandDefinition / CommandResult / CommandInvocation / CommandDescriptor / CommandExecution / ParsedCommand |
| `src/lexer.ts` | `parseCommand(line)` 纯函数（词法单源） |
| `src/tokens.ts` | `commandsChange` 事件（freeze:none——目录变更 UI 通知，非否决） |
| `src/plugin.ts` | `commandsPlugin`：提供 `commandRegistry` 服务 |
| `src/index.ts` | barrel（token/服务/插件/类型） |

- **词法**（参照系词形 + 本仓 trim 语义——行为规格以本仓为准）：`parseCommand(line)`
  先 `line.trim()`（前导空白 `/compact` 仍命中——本仓现状断言锚），再
  `/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/`——小写开头词形、分隔符 `\s`（本仓
  集合宽于参照系的 `[\t\n\r ]`，保留）；`rawInput` = 词后原文**逐字**（不二次 trim，
  消费方自行裁）；`//x` 天然不命中（第二字符非 `[a-z]`）。`/Compact` 大写两版均不
  命中（交模型）——无漂移。
- **定义**：`{ name, description, recordInput?: boolean, handler }`；name 违词形 /
  description 空 / handler 非函数 → 注册期 throw（fail-fast）；同名注册 throw。
- **结果**：`CommandResult = {kind:"success", text?, data?} | {kind:"error", text}`
  （判别联合，registry 边界校验解冻）。`data` = 结构化载荷（参照系 sourceEventSeq 的
  本仓形态：消费方在进程内，直接携带富载荷——compact 的 `{summary, replacedCount,
  summaryTokens}` 三元组经此通道原样到 wire，响应形状零漂移）。
- **执行**：`execute(session, line, signal)`：
  1. 词法不命中或未注册 → **`undefined`**（调用方分路——hub 的「execute 未命中 →
     followup 交模型」一个 if 即全部上层判断）；
  2. 已中止 signal（`signal.aborted`）→ 直接 throw（**零事件**——对齐参照系）；
  3. 命中 → 铸 `commandId`（`cmd-<instanceToken>-<seq>`，instanceToken =
     每插件实例 `randomUUID().slice(0,8)`——同进程重装配不撞车）→ append
     `command/run`（log-only，失败 fail-loud 重抛）→ **直接 await handler**（不移植
     参照系 withAbort 竞速——本仓 handler 全员 signal 协作，eager rejection 会抢先于
     runner 的静默 aborted 归一路径、使 `compaction aborted` 串不可达，破坏词表封闭）
     → append `command/done`（log-only）→ 返回 `{commandId, result}`；
  4. handler **throw**：先落 `command/done{kind:"error"}`（append 失败 contained）
     再**重抛**（调用方感知失败）；期望失败走 `{kind:"error"}` 返回值不抛。
- **服务面**：`commandRegistry = defineService<{register; list; find; execute}>`；
  register 返回 disposer（经 `ctx.effect` 绑定拆卸）；`commandsChange` 在增删时发射。
- **并发/一致性预算**：注册表同步 Map 操作；execute 不并发限制（各命令自带 busy 语义）；
  事件 append 失败 fail-loud（run）/contained（done 错误路径）——对齐参照系注释语义。

### 2.2 session WAL 词表加两条（log-only）

```ts
"command/run":  { commandId: string; name: string; args?: string }   // args 缺席 = recordInput:false
"command/done": { commandId: string; kind: "success" | "error"; text?: string }
```

- gates 形状门 + **配对不变量进 `validateSessionEvents` 全卷校验**（参照系 invariant
  插件的行为移植到我们的单点校验器，at-most-once 双向）：`command/run` 的 commandId
  不得重复；`command/done` 必须配对一个**尚未被配对**的先前 `command/run`（第二个
  done 同 id 拒）。**run 无 done 合法**（优雅关停/崩溃/torn 卷的悬挂 run——恢复面
  不 fail-closed，fork 前缀切在 run/done 之间同样合法）。违反 =
  `corrupt-envelope:<i>:...`。
- log-only ⇒ 不进 surface/deriveMessages（命令不进模型上下文）；`get_entries` 投影
  自动携带（与 session/meta 同款）。

### 2.3 compaction 包：`/compact` 自声明（`src/command-compact.ts`）

- `commandCompactPlugin`：`inject: ["commands", "compaction", "agent-loop"]`
  （compaction 已依赖 agent-loop，无环；busy 前置用 `agentLoopServiceToken` 的
  `get(id)?.agent.status`）；`ctx.effect` 注册
  `{ name: "compact", description: "Compact the conversation history", handler }`。
- handler 语义（**行为规格 = 本仓现状，非参照系**）：
  - `rawInput.trim()` 非空 → **customInstructions**（本仓 /compact 收参——参照系
    argument-free 是其产品裁决，不移植，差异表 #D2）；
  - **busy 前置**：agent 在飞（`agentLoopServiceToken` 的 `get(session.id)?.agent
    .status === "running"`）→ 既有串 `thread is streaming`（kick 窗口与 turn 窗口
    对 stdin 驱动的外部观察者等价——followup 同步置 running+turn/start，命令行是
    macrotask 不可插入；已核实无观察漂移）；插件内 `running` 布尔（handler 包装器
    **同步前缀 check-and-set，零窗口**）非空 → `Compaction already in progress`；
  - **signal 归属**：无插件内 controller——handler 的 signal 即调用方 signal（hub
    侧 = inflight 登记）；拆卸不做 abort（D5）；
  - 调 `compactionRunner.compact({session, trigger:"manual", keepRecentTokens,
    signal, customInstructions?})`；失败 reason → `compactSkipError` 既有归一映射
    （`context too small to compact` 等词表不变）；
  - 成功 → `{kind:"success", text: <compacted 统计句>}`；`keepRecentTokens` 由插件
    常量注入（现 hub 的 KEEP_RECENT_TOKENS=20_000 单一真相搬入本插件）。
- teardown：disposer = unregister（同步面；**无逃逸写保证来自拆卸序而非 disposer 自身**
  ——worker 三条拆线路径都先 abortAll（inflight，等 settle）→ handle.dispose 封存 →
  teardownWorld，在飞 handler 的 done append 落在封存后必然 `session-disposed` 失败
  contained）。参照系的 async drain-before-unregister 不移植（差异表 #D5）。

### 2.4 hub 拆迁（消费面）

- `rt.state.commands`（装配期 `tryUse(commandRegistry)` 捕获，对齐 delegationView；
  缺席 = 命令面未装配 → prompt 走纯文本路径、get_commands 退 skills-only——防御
  分支照 delegation 先例，hub 装配恒在）。
- **prompt**：`interceptCompact` 删除；分路序 = **parseImages → imagesGate →（流式
  判定前的空闲路径）命令分路**（形状/量限/能力门先于命令分路——现状序逐字保持，
  携图 `/compact` 仍 `invalid images: compact does not accept images`）。空闲路径：
  `const registration = rt.inflight.register()` → `execute(session, message,
  registration.signal)`（整个调用在既有 try/catch 内——**throw 态也恰一响应**）→
  `finally registration.unregister()`。`undefined` → followup 原路径（未注册词形交
  模型）；命中 → 成功 respond `{data: exec.result.data}`（command 字段留 "prompt"，
  data 三元组原样——**wire 形状零漂移**）/ error `exec.result.text`（既有词表串）。
  无 settled（现状语义）。abort 联动：abort 命令的 `inflight.abortAll()` 经 signal
  穿透 → runner 静默 aborted → 归一串 `compaction aborted`（行为不变）。
- **compact 协议命令**：薄壳——合成 `/compact` 行（customInstructions 有则拼）走同一
  execute（同 inflight 登记/signal/try-catch 面）；成功 data 三元组、error 既有词表
  串——响应形状零漂移。命令集仍 56。
- **busy 面**：`rt.state.compacting` 退役；桥对主会话 `command/run`/`command/done`
  维护执行中计数（sessionEvent 同步 emit——计数与 append 同步段，无竞窗）；**清账
  面：`sessionDisposed` 全清 + `unsubscribe()` 全清**（done append 落在封存后的丢失
  路径由 sessionDisposed 边沿兜底；fork 重装配经 unsubscribe 不带旧账）。心跳 busy
  判据 = 计数 > 0。`get_state.isCompacting` wire 字段保留，数据源 = 计数 > 0（本批
  唯一命令是 compact，语义等价；多命令时代字段更名挂账）。
- **get_commands**：`command-listing.ts` 改读 `commandRegistry.list()`（source 词表
  `"builtin"|"skill"` → `"command"|"skill"`，wire 词表变更，DESIGN 附录同变）+ skills
  清单合并（skills 为透传条目——未注册词形交模型的路由事实不变）。
- 删除面：`compact-invocation.ts`（词法随内核）、`runManualCompact`、
  `compactSkipError`/`KEEP_RECENT_TOKENS`（移入 compaction 包，单一真相归内核）、
  compact 专用 inflight 段（上移为命令分路公共段）。

## 3. 不处理（显式归属）

- 命令附件（input.attachments/hint/definitionId/sourceEventSeq/scoped per-agent
  遮蔽）——不移植（差异表 #D3/#D4）；客户端富卡片渲染无消费方。
- 未注册词形报错（参照系语义）——不移植；本仓 = 交模型（skill 分发面）。
- 参照系的 TypertRemote 跨进程服务/brand 类型/invariant 独立插件——映射为本仓
  defineService/模板字面量类型/validateSessionEvents 单点（同构改写）。
- CLI/app 接入——后续波次（本批交付内核能力 + hub 全拆）。

## 4. 差异表（有意变更，逐条裁决）

| # | 参照系 | 本仓裁决 | 理由 |
| --- | --- | --- | --- |
| D1 | execute 携 attachments 准入 | 不收附件；prompt 携图命中命令先拒 | 本仓命令面无附件消费方；量限/能力门已在前置 |
| D2 | /compact argument-free | args = customInstructions | 本仓现状是行为规格 |
| D3 | 未注册词形 → UI 报错 | 交模型（execute undefined） | skill 分发面（既有用户裁决） |
| D4 | scoped per-agent 遮蔽层 | 全局单层注册表 | 无 per-agent 定制消费方；挂账 |
| D5 | teardown async drain | 同步 disposer：unregister + abort 在飞 | 本仓 Disposer 同步契约 |
| D6 | `source:{kind:"user"}` / `recordInput` 反双写 | 保留 recordInput；source 不移植 | 单一来源（user）无判别价值 |
| D7 | compactNow 独立 seam + 错误码对象 | handler 直调 compactionRunner + reason 归一 | 本仓 runner 已是稳定 seam；错误码对象无第二消费方 |
| D8 | busy = "agent not idle" 错误串 | 映射既有词表串（thread is streaming / Compaction already in progress） | 错误词表封闭性（附录 A） |
| D9 | 词法不 trim、分隔符 `[\t\n\r ]` | 前导 trim 保留（本仓断言锚）+ 分隔符 `\s` | 行为规格 = 本仓现状 |
| D10 | withAbort 信号竞速（eager reject） | 直接 await handler | 本仓 handler 全员 signal 协作；eager reject 使 `compaction aborted` 归一串不可达（词表封闭） |
| D11 | sourceEventSeq（seq 指针） | CommandResult.data 结构化载荷直携 | 消费方在进程内；compact 三元组原样到 wire |
| D12 | done 仅配对先前 run | at-most-once 双向（第二个同 id done 拒） | torn 卷 fail-closed 闸的完备性 |

## 5. 旧测试迁移矩阵（hub 侧行为规格）

| 现有测试/断言 | 处置 |
| --- | --- |
| worker-embedded「prompt 携图全链」中 compact 拒图断言 | 保留（语义不变，路径改经 execute 前置） |
| worker-embedded/contracts-script-adapter 的 interceptCompact/parseSlashCommand 单测 | **改写**：lexer 测试移入内核包（词法差异：小写开头 + verbatim args 按参照系）；hub 侧删除 |
| worker-journeys「compact 双发预检 + abort 命令路径」 | 保留 + 断言扩展：双发第二响应含 `Compaction already in progress`（既有串）；abort 中止在飞 compact 语义不变（signal 路径改经 execute→inflight） |
| scenarios-contract「/compact 拦截」旅程（command:"prompt" + data 三元组） | 保留原断言（响应形状零漂移——data 通道承载三元组） |
| compact skip 归一（compactSkipError）单测 | 移入 compaction 包随迁 |
| get_commands 形状（source builtin） | 改写：source 词表 `command` |
| heartbeat busy（compacting 面）既有断言 | 改写：事件驱动计数 |
| 新增 | 内核：词法表驱动/注册校验/execute 三态（undefined/结果/重抛）/run-done 配对 gates 全卷校验/commandsChange；compaction：/compact 全旅程（成功统计句/args 透传/busy 两串/skip 归一/abort/并发第二发）；hub：prompt 分路（命中/未命中交模型/携图命中拒图）/compact 薄壳/get_commands 合并目录/busy 计数 |

## 6. 实施顺序

1. **W1** 内核 `packages/commands` + session 词表/gates/pairing + 单测。
2. **W2** compaction `/compact` 自声明 + compactSkipError/KEEP_RECENT_TOKENS 迁入 + 单测。
3. **W3** hub 拆迁（prompt 分路/薄壳/get_commands/busy 计数/删旧面）+ embedded/journeys
   改写 + DESIGN/MIGRATION 同变。
4. **W4** 收口：对抗审查（≥2 并行）→ 假绿抽查 → 四门 + 文档核销。

每波独立提交、四门全绿；覆盖率阈值不动（90/85/90/90）只升不降。
