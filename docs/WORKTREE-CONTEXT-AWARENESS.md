# WORKTREE 上下文感知方案（工作目录/分支如实呈现 + agent 自知）

> 状态：已定稿（三面对抗审查已回填——处置见 §8）
> 级别：中级（跨 harness / agent-delegation / host-hub / cli 四层；协议契约加项；无并发/一致性新预算）
> 上游：docs/AGENT-DELEGATION.md §8（worktree 隔离）；docs/WORKSPACE-ROOT-INJECTION.md（cwd 锚定）；
> docs/SYSTEM-PROMPT.md §1.4（facts 变量与 ENV 块——本件同变面）。
> 与 M7/F7（docs/TAIL-SNAPSHOT-CHANNEL.md）的关系：**相邻件而非该件**——M7 预留的
> 「per-session cwd 指令文件注入」（worktree 子读 worktree 的 AGENTS.md）本件不交付，
> 该缝仍开放另件；本件只覆盖系统提示词 Environment 面。指令注入维持 M7 裁决
> （全部会话注入宿主装配 cwd 的指令文件）——「Environment 说 worktree、项目指令
> 来自主仓」是 M7 已接受的已知偏差，非本件制造。

## 0. 问题（用户报告的症状）

1. **界面显示仍是 main**：host-hub 协议 `thread/list`/`thread/start`/`thread/resume`
   只携带 `cwd`，无任何 git 事实。GUI 只能显示启动时 cwd。
2. **worktree 子代理不自知**，且按形态分两Track（审查 B1 修正了原问题陈述）：
   - **untyped/fork 子**：走 `prompt.assemble`，ENV 块渲染宿主装配 cwd（主仓路径）——
     与工具执行面（bash cwd = worktree、PathGate 根替换）矛盾；
   - **named 子**（.md 类型与 builtin `general-purpose`/`explore`）：`options.systemPrompt`
     静态短路（step.ts:209 `deps.options.systemPrompt ?? assemble`），**连 Environment 块
     都没有**——既不知道主仓也不知道 worktree。
3. **手建 worktree 场景**（用户自建后在子目录开线程）：探测面同样缺席。

执行面已经是对的（撒谎的是提示词与协议显示面）：`tool-bash/src/bash.ts:94`
cwd 取 `rootOverrideOf(session)?.dir ?? gate.root`；PathGate override 替换根。

## 1. 契约

### 1.1 git 事实探测（packages/harness，单一真相）

`base-prompt-probe.ts` 新增纯 fs 同步探测（无 git 子进程——热路径，`thread/list` 每调用现算）：

```ts
export interface GitFacts {
  readonly branch?: string;        // 分支名；detached/不可判 → 键省略
  readonly worktreeMain?: string;  // linked worktree 主仓顶；主仓本体 → 键省略
}
export function probeGitFacts(cwd: string): GitFacts;
```

探测序（裁决 D7——键省略是 wire 形态，非 null/空串）：
0. **cwd 存在性前置**（statSync）：不存在 → 返回 `{}`（双键省略）——防向上游走
   命中无关祖先仓（审查应修 5：worktree 被删后 home 目录 dotfiles 仓误显示）；
1. 自 cwd 向上寻 `.git`（目录或 file 皆算——与 `isGitWorkdir` 共享游走）；
2. `.git` 目录（主仓本体）→ 读 `<.git>/HEAD`：`ref: refs/heads/<b>` → branch；
   detached（40hex）→ branch 省略；
3. `.git` file → `parseWorktreeGitdir`（agent-delegation 导出的纯函数，见 1.2）解析
   gitdir：**branch 恒读 `<gitdir>/HEAD`**（独立于归属事实）；gitdir 含
   `/.git/worktrees/` 段 → worktreeMain = 段前缀，不含（submodule 形态
   `gitdir: …/.git/modules/x`）→ worktreeMain 省略（审查 3-2 裁决：分支事实与
   归属事实解耦）；
4. 任一步 IO 失败/垃圾 → 对应键省略（降级不崩）。

### 1.2 主仓顶解析单一真相（agent-delegation）

`worktree.ts` 的 `mainRepoTopOf`（async）拆出纯函数导出：

```ts
export function parseWorktreeGitdir(gitFileText: string): { gitdir: string } | undefined;
export function worktreeMainOfGitdir(gitdir: string): string | undefined; // /.git/worktrees/ 段前缀
```

`mainRepoTopOf` 重构消费之；harness `probeGitFacts` 消费之（harness →
agent-delegation 依赖已成立：`packages/harness/src/index.ts:18` 直接 import）。

### 1.3 BasePromptFacts 扩展与 ENV 块（packages/harness）

```ts
readonly gitBranch?: string;        // 在场才渲染
readonly gitWorktreeMain?: string;  // 在场才渲染
```

`normalizeBaseFacts` 同步收（合法 string 才收，垃圾丢弃）。ENV 块增两行
（在场才渲染）。实现：ENV 块由 base-prompt 源头条件拼接；**cwd/isGit/platform/shell
四个变量保留注册**（第三方段 `{{cwd}}` 不破——审查应修 6）；同提交更新
docs/SYSTEM-PROMPT.md §1.4。

**与主仓在途改动协调**（审查 6-2）：main 工作区未提交改动已引入
`baseCoreText(options)` + `environmentKnown`（条件省略 ENV）。本件实施时在该形态上
叠加 git 行（同域合并，非并行重构）；模板用例须覆盖「gitBranch 缺席 + 全 facts
缺席叠加省略」形态。

### 1.4 worktree 子会话环境事实注入（双轨——审查 B1 重裁，D2'）

**Track N（named 子：静态 prompt 拼接，agent-delegation）**
`childAgentOptions`（spawn.ts）/`revivedOptions`（revive.ts）：worktree 在场时
`systemPrompt = named.prompt + "\n\n" + worktreeEnvBlock(plan)`。环境块文本
delegation 自有（新文件 `worktree-env.ts`，不 import harness——依赖方向不许）：

```
## Environment

You are running in an isolated git worktree — this is your workspace:
- Working directory: <path>
- Git branch: <branch>
- Main repository (read-only reference, outside your sandbox): <main or "unknown">
```

revive 侧时序：worktree 事实预解析（.git file → gitdir → main/branch，同 1.2 解析）
**提前到 loop.resume 之前**（options 在 resume 时定格）；`replayWorktree` 复用预解析
结果。branch 读 gitdir HEAD（非推定 `x-harness/<agentId>`——审查可接受 7 采纳）。
非 worktree 的 named 子：零改动。

**Track U（untyped/fork 子：会话层 base/core 覆盖，packages/harness）**
`createWorktreeContextPlugin()`（harness 新文件 worktree-context.ts）：监听
`agentSpawned`（payload 见 1.5；worktree+branch 双在场门）→ 对子会话
`prompt.scoped(sessionId).section({ name: wellKnown.baseCore, text })`——完整
base/core 文本、ENV 块换 worktree 事实 + 主仓只读语义句。`sessionDisposed` 自动清层
（system-prompt plugin 已挂钩）；插件另持 `Map<SessionId, Disposer>`，监听
`agentWorktreeGone`（1.5）摘层 + sessionDisposed 删表项（有界，无泄漏）。
revive 复活同经 agentSpawned → 覆盖自动重建（emitSpawned 在 resume 后、kick 前，
时序安全——审查核实）。

**装配点（审查 2.3/B3，写死两处）**：
- harness `delegationKit` 内包（CLI 随 delegation 同进退）；
- hub `defaultWorkerPlugins`（assembly.ts）紧邻 `createAgentDelegationPlugin`。
  hub 直用 createAgentDelegationPlugin 不经 kit——必须显式接线，否则功能在 hub 缺席。

**stop 悬挂处置（审查应修 4，R2 裁决）**：stop 的 removed 分支（树已删、会话驻留）
发射 `agentWorktreeGone { sessionId, agentId }`；Track U 摘层。Track N 残差如实落档：
静态 options 不可变，驻留期（stop 后未复活）env 块指向已删树——复活即自愈
（options 重建，树不在场不拼）；接受为已知窗口。

### 1.5 协议显示面（契约加项）

**agent-delegation**：
- `AgentSpawnedPayload` 增 `worktree?: string` / `branch?: string` / `worktreeMain?: string`
  ——spawn 发射点取 `WorktreePlan` + 新树 .git 解析的 worktreeMain（**非** plan.repoTop：
  嵌套形态下 rev-parse toplevel = 父 worktree，不是主仓——审查应修 3 的单一来源裁决 D6）；
  revive 发射点取预解析结果；不可读 → 键省略；
- 新事件 `agentWorktreeGone`（freeze:none）；
- `ChildView` subagent 形态增 `worktree?: string`（lineage 行事实透传）。

**host-hub**：
- `thread/list` 每行增 `gitBranch?: string`（现算 `probeGitFacts(entry.cwd)`，键省略形态；
  门两重：仅 live 系状态 + cwd 绝对路径——相对串/落表归一前的历史脏数据键省略，
  防宿主进程所在仓冒充线程分支）；
- `thread/start`/`thread/resume`/**fork/clone** 响应 data 增 `gitBranch?: string`（worker 装配期
  probeGitFacts 位点；控制响应转发链 `worker-control.ts` 只校验 threadId/sessionPath
  形状，加字段无碍——审查核实）；
- host 表**不落账**分支（易变事实，落账必陈旧——D3）；
- entry.cwd 脏边如实落档（审查 4.2）：resume 预占插入未归一 `input.cwd`、register
  兜底宿主 `process.cwd()`（WORKSPACE-ROOT-INJECTION.md:90 既有落档项）——探测经
  D7 存在性前置 + 键省略降级，纯显示面无安全后果。

**边界（不处理，归属）**：
- GUI 渲染（Pai.app 仓）——协议字段交付即止；
- `thread/list_saved` 分支列——历史档案瞬时事实，另件；
- 嵌套 worktree 建树基准——现状语义如实：子树从 **repoTop（探测锚仓顶；嵌套形态 =
  父 worktree）的 HEAD** 建（§2 修正原引述），本件不改该基准；
- 会话中途 checkout 换分支提示词不热更——facts 装配期快照（M7 同款），
  `thread/list` 现算面自动跟随；
- per-session cwd 指令注入——M7 另件，本件不动。

### 1.6 CLI 宿主

`apps/cli` build-world facts 探测同源接 `probeGitFacts`。CLI 无状态栏渲染面，
不加显示（无消费面不加死代码）。

## 2. 方向性裁决（含审查后新增/重裁）

| # | 裁决 | 依据 |
| --- | --- | --- |
| D1 | 探测纯 fs 读 .git/HEAD，不起 git 子进程 | 热路径；HEAD 格式是 git 稳定契约；不受 GIT_DIR 注入影响 |
| D2' | **双轨**：named 拼接静态 prompt / untyped 会话层覆盖 | step.ts:209 静态短路——单轨对 named 无效（审查 B1 重裁） |
| D3 | 分支不落账，显示面现算 | 易变事实落账必陈旧；现算即「自动切换」 |
| D4 | Track U 文本自烘焙（不重跑探测） | spawn 时刻 plan 事实在手 |
| D5 | 非 worktree 子零改动 | 其执行面即主仓 cwd，无矛盾 |
| D6 | worktreeMain 单一来源 = 新树 .git gitdir 解析 | plan.repoTop 嵌套形态是父 worktree（rev-parse toplevel），非主仓 |
| D7 | probeGitFacts 存在性前置 + 键省略 wire 形态 | 防祖先仓误命中；消费方按在场渲染 |
| D8 | agentWorktreeGone 事件摘层；Track N 驻留残差落档 | stop removed 分支会话驻留、树已删 |

## 3. 并发/一致性预算

无新增并发面。探测同步 fs ≤ 2 小文件读/线程；`thread/list` **仅 live 系行**（spawning/
live/retiring ≤ maxThreads 32）探测且 cwd 须绝对路径——非 live 表项（parked/dead，1024
FIFO 深表）不探（dead 行分支是语义噪音；全量同步探测在慢盘 NFS 上饿死 host 事件循环，
审查实测本地 91ms/1024、慢盘可达分钟级）。分支拒绝落账（D3）。

## 4. 实施顺序

1. agent-delegation：`parseWorktreeGitdir`/`worktreeMainOfGitdir` 抽取（mainRepoTopOf
   重构消费）；payload 三字段 + 两发射点；`agentWorktreeGone` 事件 + stop removed 分支
   发射；`worktree-env.ts`（Track N 文本）+ childAgentOptions/revivedOptions 拼接
   （revive 预解析前移）；ChildView 增列；
2. harness：`probeGitFacts`（D7 序）；BasePromptFacts 扩展 + ENV 条件行
   （**与主仓在途 base-prompt 改动同域合并**——baseCoreText(options)/environmentKnown
   形态上叠加）；`worktree-context.ts`（Track U + gone 摘层）；delegationKit 内包；
   docs/SYSTEM-PROMPT.md §1.4 同变；
3. host-hub：`defaultWorkerPlugins` 接线；thread/list 现算 gitBranch；thread/start|resume
   响应增字段（worker 装配位点 + host 转发链核对 worker-control.ts）；
4. cli：build-world facts 接线；
5. e2e：delegation worktree 旅程装置补 `createBasePromptPlugin` +
   `createWorktreeContextPlugin`（**packages/e2e/package.json 增 `@x-harness/harness`
   依赖**）；host-hub embedded worker 用例（见 §6）。

## 5. 测试口径

**harness probeGitFacts**（表驱动，零 git 二进制）：

| # | 形态 | 造法 |
| --- | --- | --- |
| 1 | .git 目录 + ref 行 | mkdir + write HEAD |
| 2 | detached 40hex | write |
| 3 | HEAD 垃圾文本 | write |
| 4 | HEAD 不可读 | HEAD 造成目录（EISDIR） |
| 5 | 无 .git | 纯 temp |
| 6 | .git file → gitdir/HEAD ref | 手造双层目录 |
| 7 | gitdir 指向不存在路径 | `gitdir: /nonexistent` |
| 8 | .git file 无 gitdir 行 | write 垃圾 |
| 9 | gitdir 无 worktrees 段（submodule 形态） | branch 在、worktreeMain 省 |
| 10 | **cwd 不存在** | 返回 `{}`（D7 回归锚） |
| 11 | 子目录上寻命中 | 现成先例 base-prompt-probe.test.ts:16 |
| 12 | parseWorktreeGitdir 字符串表 | CRLF/多行/空白 |
| 13 | normalizeBaseFacts 垃圾 | 数字/对象/空串丢弃 |

**Track U 插件**（harness `__test__/worktree-context.test.ts`，装置：createContext +
loadPlugins([systemPromptPlugin, createBasePromptPlugin(FACTS), createWorktreeContextPlugin()])，
`ctx.emit(agentSpawned, …)` 直发——先例 bridge-units.test.ts:127）：
- 三面断言：子 `assemble({sessionId})` 含 worktree 行**且不含 FACTS.cwd**；根层
  `assemble()` 发射前后 fingerprint 逐字节不变；payload 缺 worktree/缺 branch 不注册；
- `agentWorktreeGone` → 摘层（回根层文本）；`sessionDisposed` → 层清 + map 删项。

**Track N**（agent-delegation）：spawn(isolation=worktree, subagent_type=named) → 子
options.systemPrompt = 正文 + env 块（含 path/branch/main）；非 worktree named 零改动
（逐字节不变断言）；revive → 预解析事实入块、branch 读 gitdir HEAD。

**协议面**：emitSpawned payload 三字段（spawn+revive）；ChildView.worktree；
stop removed → agentWorktreeGone 恰一次、kept-dirty 不发。

**host-hub**（embedded worker 装置，git 夹具新模式——照抄 worktree.test.ts:47-59
`git -C` 显式口径）：thread/list 真仓 cwd → gitBranch 在场；detached → 键省略；
thread/start 响应含 gitBranch；**装配面锚**（防功能缺席全绿——审查 B3）：embedded
worker + 真 git cwd + script `agent_spawn{isolation:"worktree"}` → 子会话
system/message（get_entries）含 worktree 路径；一致性锚：同仓同分支时 list 与 start
的 gitBranch 相等（防两源漂移）。注意 `apps/host-hub/src/worker/**` 在覆盖率分母内。

**回归锚**：模板 git 行缺席时无 `{{` 残留——现存 `not.toContain("{{")`
（base-prompt.test.ts:21）直接抓红，无需新护栏；`thread/register` 精确 toEqual
（host-commands.test.ts:228）是越界护栏——本件不动 register。

**e2e**：worktree 旅程断言升级——子首个 LLM 请求 system 文本含 worktree（证明 loop
真消费会话层投影；适配器收全量 LlmRequest，先例 agent-journey.ts:38）+ 根层
fingerprint 不变；断言须在 task_stop 前（sessionDisposed 清层）。

## 6. 明确不处理清单

GUI 渲染；thread/list_saved 分支列；嵌套建树基准改动；会话中 checkout 热更；
per-session cwd 指令注入（M7 另件）；Track N stop 后驻留期 env 块残差（复活自愈）；
entry.cwd 未归一/register 兜底脏边（既有落档项，D7 降级兜住显示面）。

## 7. 对抗审查处置（三面回填记录）

| 来源 | 发现 | 严重度 | 处置 |
| --- | --- | --- | --- |
| 规格面 #1 / 架构面 #7 | named 子静态 systemPrompt 短路 assemble，会话层覆盖对最常用形态无效 | **阻断** | 采纳：D2' 双轨重裁（Track N 拼接 / Track U 覆盖） |
| 测试面 1-1 | e2e 装置无 base 插件，覆盖断言恒真（假绿） | **阻断** | 采纳：装置双插件 + 三面断言（§5） |
| 测试面 7-1 | 装配接线在方案缺席（hub 功能可缺席全绿） | **阻断** | 采纳：delegationKit 内包 + defaultWorkerPlugins 显式接线 + 装配面测试锚 |
| 规格面 #2 | payload 缺 worktreeMain，契约不自洽 | 应修 | 采纳：payload 三字段（§1.5） |
| 规格面 #3 | 嵌套形态 plan.repoTop ≠ 主仓；「从主仓 HEAD 建」引述为假 | 应修 | 采纳：D6 单一来源=新树 .git 解析；§2 引述修正 |
| 规格面 #4 | stop removed 分支覆盖悬挂 | 应修 | 采纳：agentWorktreeGone 摘层（D8）；Track N 残差落档 |
| 规格面 #5 | cwd 被删后游走误命中祖先仓 | 应修 | 采纳：存在性前置 + 键省略（D7） |
| 规格面 #6 / 测试面 6-2 | ENV 烘焙与 SYSTEM-PROMPT §1.4 冲突；与主仓在途改动同域 | 应修 | 采纳：文档同变 + 变量保留注册 + 合并协调落 §4 |
| 架构面 1.1 | 「即 M7 另件」自称与边界矛盾 | 应修 | 采纳：上游注改「相邻件」（篇首） |
| 架构面 2.3 | 插件无装配点裁决 | 应修 | 采纳（并入 B3 处置） |
| 测试面 1-2 | 「适配器不可达」前提为假 | 应修 | 采纳：主断言改子首 LLM 请求 system 文本 |
| 测试面 1-3 | e2e 包缺 @x-harness/harness 依赖 | 应修 | 采纳：§4 步骤 5 |
| 测试面 3-2 | submodule 形态 gitdir 未裁决 | 应修 | 采纳：branch 与归属解耦（§1.1-3） |
| 测试面 4-2 | host-hub 零 git 夹具先例 | 应修 | 采纳：夹具方案落 §5 |
| 测试面 5-1 | 分支用例清单缺席 | 应修 | 采纳：13 行表落 §5 |
| 测试面 7-2 | list/start 两时点探测漂移不可见 | 应修 | 采纳：一致性锚（§5） |
| 规格面 #7 | revive branch 是推定非核实 | 可接受 | 采纳升级：读 gitdir HEAD |
| 架构面 4.2 | entry.cwd 脏边 | 可接受 | 落档（§1.5） |
| 架构面 8 / 2.1 | 文件指错（worker-control/index.ts） | 笔误 | 修正落点 |
| 架构面 2.2/3.1/4.1/5.1/6.1、测试面 2-1/3-1/3-3/4-1/6-1/7-3 | 事件窗口/fingerprint/锚定表/同名顶替/装置先例等 | 核实无冲突 | 依据直接进 §1 |
