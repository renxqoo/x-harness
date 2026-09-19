# TASKS：通用任务动词件（件 14）

> 状态：**已实施**（方案定稿两路审查 27 项全处置 §10；实施前二次自洽压测 ⑥⑦⑧ 并入；
> 收口审查与四门见文末实施记录）
> 级别：中（task-tools 新包 + agent-delegation 工具面迁移 + bash 源接入（时为 toolbox，现为
> tool-bash）+ 测试迁移）
> 上游裁决：件13 U2（任务体系不并入）本件部分兑现——**模型侧动词统一为 task_output/task_stop，
> 跨任务源（agent 子代理 + bash 后台任务）**；TOOLBOX.md §150/§246/§289「未来任务件」即本件。
> 用户指令（2026-09-19 一次）：agent_output/agent_stop 改名 task_output/task_stop，单独
> 插件，bash 侧共用。**用户指令（同日二次）：任务逻辑不写进命令工具包（时为 toolbox——零改动；
> 后 toolbox 拆为一命令一包，bash 源 = @x-harness/tool-bash 的 BackgroundTasks 公开面）**。
> **用户指令（同日三次）：没有 task-bash——bash 源适配收进 task-tools 本体（工厂参数收
> bashTasks 句柄）；LLM 面上只有 task_output/task_stop 两个工具，无第三者**。

## 0. 目标与边界

消灭「描述承诺 task_output 而工具不存在」的契约缺口，并把读/停动词从 agent-delegation
拆出为跨源通用面。**终态**：`task_output`/`task_stop` 由独立插件（@x-harness/task-tools）
提供，经 TaskHub 服务路由到注册的任务源；agent-delegation 注册 `agent` 源（原 agent_output/
agent_stop 语义迁移——含签名重构，见 §4）；**bash 源在 task-tools 本体内注册**（工厂参数收 `bashTasks: BackgroundTasks`
公开句柄，桥接适配器为 task-tools 内文件——命令工具包零改动，无独立 bash 插件，
见 §3）。**LLM 可见面 = task_output + task_stop 两个工具，别无其他**。

不做（落档 §9）：任务枚举/清单工具、跨源统一 id 铸造、任务持久化、remote 会话源。

## 1. 契约

### 1.1 工具面（task-tools 注册；**不留 agent_output/agent_stop 双轨**）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `task_output` | `{task_id, offset?, block?, timeout?}`（offset 为非负数，schema `Type.Number` minimum 0——**不用 Integer**：tools validate 按 Kind symbol 派发，integer 是否在派发面未核实；bash 源 headBytes 对非整数/非有限值本就防御性取整归零，垃圾输入降级不崩溃） | task_id：agent 任务的 agentId/name/`name [ref]`（owner 限定），或 bash 后台任务 id（会话键控）。**offset 是规格外本仓扩展**（上游三参数 task_id/block/timeout——增量读靠输出文件+Read；本仓 bash 源以 offset/nextOffset 表达，agent 源忽略）。**block 缺省 true**（与上游规格 :113、件13 §2.1、反自旋原则一致——bash 源无完成通知，缺省阻塞正是省轮询手段；拉模式裁决裁的是通知机制非单次调用阻塞缺省）。timeout 缺省 30000、min 0、max 600000；**timeout=0 = 零等待立即快照**。agent 源 block=true = whenIdle race（在飞快照带末轮摘要）；bash 源 block=true = whenSettled 有界等终态（§3.2），到点未完回 running/killed 中间态快照（state 自述） |
| `task_stop` | `{task_id}` | agent 源：cancel+whenIdle 收敛+幂等+停止非销毁（可再 message 复活）+ worktree 清理评估（kept 带路径）。bash 源：两段杀（term→kill）发起 + **whenSettled 有界收敛后铸终态快照**（KILL_GRACE+余量 8s 上界；超时如实回 mid-kill 快照——state=killed/exit=null 属实瞬态，铸文容忍）；**stop 发起前已终态（endedAt 已置）的任务铸文加 already finished 前缀**——裸 "Stopped" 对 completed 任务是谎言 |

**工具入口前置校验**（不进路由）：task_id 空/含换行/调用方无 session → invalid-args；
`task_id === "main"` → `invalid-args:task_id 'main' is not a task`（denied 同款终结）。

**offset × block 交互（自洽压测补定义）**：block=true 等的是**终态**（agent=当轮 idle、
bash=进程 settle），**不是「有新字节」**——带 offset 的增量进度轮询若沿用缺省 block=true，
长任务（dev server 类）每次读都挂满 30s。裁定：缺省恒 true（可预期性优先，不做「传了
offset 就隐式改 false」的魔法），**描述明写**「进度轮询长任务传 block:false」；bash 源
block=true 的返回 = 终态后从 offset 起的切片（语义自洽：先 settle 再切片）。

返回铸文：
- agent 源读：件13 reportText 口径（末轮 reason 全集 + reportCap 截断 + agent_message
  追问引导）。
- bash 源读：`task <id> (<command 截 80 字符>): <state> exit=<code|null> bytes=<n>` 头 +
  text 切片 + 尾注（`nextOffset=<n>; more=<bool>`；truncated/spill 全文路径提示）。
- 停止：源各自终态文案；agent 源保留「可再 message」与 worktree kept 注记。

错误词表（跨源统一）：全 miss → `not-found:<task_id>; no such task in any source (agent
tasks: use list_agents; bash ids come from bash run_in_background; bash tasks are
session-scoped)`（提示语按双源齐备写——纯 bash/纯 agent 装配下他源提示冗余但无害，
静态文案不做装配态分叉）；**源内 definite 错误（not-owner 等）经 denied 通道透传原文案**。命中后
行消失的迟到 not-found（档化/逐出竞态）回落统一词表——两套口径并存如实说明。

并发声明（沿件13）：task_output = parallel；task_stop = exclusive。

### 1.2 TaskHub 服务与三态路由

```ts
export type TaskProbe =
  | { readonly kind: "hit" }                                       // 本源认领，续走 output/stop
  | { readonly kind: "denied"; readonly reason: string }           // 认领但终结（not-owner/invalid-args）——路由终止，透传源文案
  | { readonly kind: "miss" };                                     // 非本源——续试下一源
export interface TaskSource {
  readonly kind: "agent" | "bash";                                 // 闭合词表
  probe(taskId: string, caller: SessionId | undefined): TaskProbe;
  output(taskId: string, caller: SessionId | undefined, opts: { offset?: number; block?: boolean; timeout?: number }): Promise<Outcome<Text>>;
  stop(taskId: string, caller: SessionId | undefined): Promise<Outcome<Text>>;
}
export interface TaskHub {
  registerSource(source: TaskSource): () => void;                  // 重名 kind throw（装配 fail-fast）；注册方自经 ctx.effect 挂摘除
}
```

- **路由序固定**：hub 按 kind 字典序遍历（agent 先于 bash）——不依赖注册时序，同名撞形
  id（`t-<12hex>` 是合法 agent 名）在不同装配下解析一致。
- **路由安全论据（修正）**：bash id = `t-`+12hex（tasks.ts 铸造）、agentId = `agent-`+8hex，
  两前缀正交；裸名撞 bash id 需「同名 + 同会话同 id」双重巧合（概率可忽略）且定序兜底。
- **单源异常隔离**：路由层 try/catch 单源 probe/output 异常 → 按 miss 计 + onWarn 留痕
  （单源 bug 不打穿另一源）。
- **block 归一化点**：工具层显式 `block: opts.block ?? true` 传源（verbs 内部 `!== false`
  口径与之一致——不依赖双层缺省巧合）。

## 2. 包边界与依赖

```text
packages/task-tools（新；依赖 core + session[SessionId] + tools[ToolDefinition] +
  tool-bash[BackgroundTasks 类型与适配——命令工具包公开面]）
  tokens.ts（taskHub）
  plugin.ts：createTaskToolsPlugin(options?: { bashTasks?: BackgroundTasks })——
    name "task-tools"，inject ["tools"]（拓扑保证 registry 先行）；provide hub +
    注册两工具；bashTasks 在场则一并注册 bash 源（摘除经 ctx.effect）
  tools.ts（工具面 + 三态路由 + 铸文）
  source-bash.ts（bash 源适配器 + 外置 waitSettled——§3）
  __test__/

agent-delegation：inject 增 "task-tools"（硬依赖：无 hub 装配即失败——output/stop 是
  子代理面一部分，不静默降级）；verbs.output/stop 改造为 agent TaskSource（session 提参
  签名重构，非直通）。

命令工具包（时为 toolbox，现拆为 tool-bash 等）：**零改动**——tasks 句柄与 read/stop
  公开面（TOOLBOX.md §4「本登记簿经 createBashPlugin({ tasks }) 穿引实例供给」即本接线）。
```

依赖方向：agent-delegation → task-tools → core/tools/session/tool-bash（另有 agent-delegation
→ tool-core，test-only——worktree 隔离用例消费 PathGate/admitSession 公开面）；tool-bash 不依赖
任务层。无环。装配：bash 后台任务要进 task_output 面 = `createBashPlugin({ gate, tasks })`
与 `createTaskToolsPlugin({ bashTasks: tasks })` 穿引同一 BackgroundTasks 实例（未传 →
bash id 落统一 not-found——装配纪律落档
§9）。一 hub 一 bash 源（重名 kind throw fail-fast）。

## 3. bash 侧怎么改（task-tools 内适配——命令工具包零改动，无独立插件）

### 3.1 接线（装配层传句柄）

宿主装配：`const tasks = new BackgroundTasks(defaultTaskLimits({}, limits));
loadPlugins(ctx, [..., createBashPlugin({ gate, tasks }),
createTaskToolsPlugin({ bashTasks: tasks }), ...])`——工厂参数直取
BackgroundTasks 公开句柄（TOOLBOX.md §4「本登记簿经 createBashPlugin({ tasks }) 穿引实例
供给」的原设计兑现）；task-tools apply 即 `ctx.use 自身 provide 的 hub` 注册
`bashTaskSource(bashTasks)`，摘除经 ctx.effect。无命令包内 tryUse/waitFor 时序问题
（原 B-P0-2 装配序脆弱性随工厂注入消解）。

`bashTaskSource(tasks)`（task-tools/src/source-bash.ts）：
- `probe`：`tasks.read(caller, id, 0)` ok → hit；miss → miss（会话键控即属主面）。
- `output`：read(caller, id, offset ?? 0) → §1.1 bash 铸文。
- `stop`：tasks.stop 发起两段杀 → `waitSettled(...)` 外置收敛 → 终态快照铸文。

### 3.2 外置等待原语（不改 tasks.ts——命令工具包零改动约束）

`waitSettled(tasks, session, id, timeoutMs)`（source-bash.ts 内）：
- **收敛判据 = `snapshot.endedAt !== undefined`**（endedAt 只在 finalize 置位——五条终态
  路径唯一收口，天生规避 stop/timeout 乐观置态期的 mid-kill 撕裂快照；state 字段是
  乐观面不可用作判据）。
- 实现 = **内存态轮询，但轮询面用 `tasks.list(session)` 而非 `tasks.read(..., 0)`**
  （25ms 间隔）——read 每次调用 `Buffer.from(full, "utf8")` 全量重编码整个保留缓冲
  （fullCap 64MB × 每秒 40 次 ≈ GB/s memcpy，非「可忽略」）；list 只读 rec 字段拼
  snapshot 不碰缓冲区。settle 后才做唯一一次真 read 切片。纯内存 Map 查询无 fs。
  超时回当前快照（state 自述）。
- 与审查 B-P1-3 原设计（登记簿内 waiters/finalize 单点释放）的取舍：外置轮询为满足
  「命令工具包零改动」约束的等价实现——撕裂快照防护同效（判据同为 finalize 产物），
  代价是 25ms 粒度的唤醒延迟（相对 KILL_GRACE 5s 可忽略）；登记簿内原语不建。
- rec 已被 evict 的竞态：list 中 id 消失 → 停止等待，最终 read miss → 如实返回 miss
  口径（stop 收敛期极罕见，统一词表兜底）。

### 3.3 文案

toolbox 的 bash 描述既有 "poll its output and state via the task layer (task_output)"
提法不动（对方在途文案，归属 toolbox）——兑现关系：装配传 bashTasks 后为真；装配了
task-tools 但未传 bashTasks：bash id 落统一 not-found（文案含 bash ids 来源提示，
模型可自纠）；task-tools 均未装配：描述提法失信属非常规部署（落档 §9 装配纪律）。

## 4. agent-delegation 侧怎么改

1. `tools.ts` 删两工具注册；`descriptions.ts` 删 AGENT_OUTPUT/AGENT_STOP_DESCRIPTION
   （task-tools 重写为跨源口径）。`delegationTools` 剩 agent_spawn/agent_message/list_agents。
2. `verbs.ts` output/stop 保留为内部实现但**签名重构**：ToolExecContext → `caller:
   SessionId | undefined` 提参（无效调用方判定上移工具入口前置）；包 `agentTaskSource(
   verbDeps): TaskSource`——probe = nameaddr 分支 2/3/4 解析 + owner 预检（not-owner →
   denied；`main` → denied invalid-args；解析 miss → miss）。
3. plugin：inject 增 "task-tools"；apply `ctx.effect(ctx.use(taskHub).registerSource(
   agentTaskSource(...)))`（摘除经 effect——apply 中途 throw 回卷也摘）。
4. **双轨残留清理**：`notify.ts` 通知尾注「(use agent_output with agentId ... for the
   full report)」、`types.ts` 注释（reportCap「agent_output 报告截断上界」）——两处同步改
   task_output（spawn.ts 修订A 时已无 agent_output 文案，方案早前所记三处为二处）；
   验收 grep 锚：src 全仓 `agent_output|agent_stop` 清零（docs 历史节除外）。
5. `list_agents` 不动（子代理视图，非任务清单——落档 §9）。

## 5. 测试计划（迁移文件与断言不变式逐条）

- task-tools `__test__`（本包内——禁跨包引用）：三态路由（hit/denied 透传 not-owner
  原文案/miss 续走→统一词表）；denied 不续走（bash 任务存在也不被 agent 源 denied 遮蔽）；
  定序（agent 先于 bash）；单源 probe 抛错隔离（stub 源 throw → miss 计 + warn）；
  block 归一化（省略 → 显式 true 达源）；重名 kind throw；匿名/空 task_id/main 前置拒；
  **双向对账用例随迁本包**（PARAM_WORDS 增 offset；锚词按新描述重写：block=true/timeout/
  task_id/Idempotent/nextOffset）。
- delegation 平移（经 task-tools 工具面调用）：`nameaddr.test.ts`（output 按名/[ref]/
  block 超时快照——**无显式 block 的读改显式 block:true 防缺省误读**）、`delegation.test.ts`
  （X11 cap 截断/X19 幂等/属主——**not-owner/already stopped/use list_agents 三锚逐字
  保留**）、`notify-path.test.ts`（reportText 直测不动；经工具面的 stop/output 用例随迁；
  通知文本断言 agent_output→task_output）、`worktree.test.ts`（stop kept 文案）、
  `revive.test.ts` 不涉。world.ts 装配加 createTaskToolsPlugin（inject 硬依赖拓扑验证）。
- task-tools 内 bash 源用例（本包 `__test__`）：probe 会话键控（越权 miss/合法 hit）；
  offset 增量连续性（nextOffset 回传）；stop 收敛终态非 mid-kill（endedAt 判据——断言
  返回快照 exitCode/endedAt 已置）；waitSettled 超时回当前快照；evict 竞态容忍。既有
  toolbox tasks.test 零改动（登记簿内核未动）。
- e2e：`toolbox-journey.ts` 后台任务段改经 task_output/task_stop（旅程装配传
  bashTasks——pollTaskDone 直柄废弃，旅程成为 bash 源接线自动探测点）；`delegation-journeys.ts` worktree 旅程
  `agent_stop` 调用改 `task_stop`；`delegation-journey.ts` 无 output 段（现状核实）仅
  装配加插件；`cross-peer.ts` 装配加插件（漏装即 peer 崩——验收探针）。

## 6. 实施顺序

A. task-tools 新包（hub + 三态路由 + 两工具 + bash 源适配（source-bash + waitSettled）
   + stub/真句柄单测 + 对账——toolbox 全程零改动）。
B. delegation 迁移（工具摘除 + 源注册 + 签名重构 + 双轨文案清理 + 用例平移 + world/e2e
   装配补插件——**装配破坏面清单：world.ts / delegation-journey.ts / delegation-journeys.ts
   / cross-peer.ts / plugin-manager 动态装配面**，逐一验证；e2e 旅程传 bashTasks）。
每步四门绿；收口前代码级两路对抗审查（沿仓规）。

## 7. 文档同变清单（逐节）

- 本文件（件14）定稿。
- AGENT-DELEGATION.md：§2.1 工具表（output/stop 两行迁出并指向件14）、§2.3 对账原则
  （对象随迁）、§4.4 属主边界（task_output/task_stop 提法）、§5.2（task_id 解析提法）、
  §8.3（agent_stop→task_stop）、§11（用例迁移注记）；历史节 §12/§14/§15 加注不改写。
- TOOLBOX.md：**零改动**（§150/§246/§289「未来任务件经 tasks 句柄供给」注记即本件
  兑现——接线在 task-tools，登记簿文档无需变）。

## 8. ~~审查关注点~~ （已由 §10 处置表取代）

## 9. 不处理（落档）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 任务枚举/清单工具（/tasks 面） | 用户未指令；agent 有 list_agents，bash id 由返回值持有 | 后续任务件 |
| 跨源统一 id 铸造/全局注册表 | 定序路由已闭环；第二真相反伤 | 不建 |
| 任务持久化/跨重启任务面 | 登记簿生命周期=会话（TOOLBOX.md 既有裁决） | 后续件 |
| remote 会话源（规格 TaskOutput/Stop 覆盖 remote session） | kind 闭合 agent\|bash；remote 无基建 | 云接入件 |
| task_output 不继承规格 DEPRECATED 定位（件13 U2 裁决随迁——本工具为一等读面） | 无文件指针替代路径 | 本件裁定 |
| TaskStop 的 shell_id（规格已弃用参数）与 teammate 形态（name@team） | 不实现 | 本件裁定 |
| bash 后台任务进 task_output 面需装配时传 bashTasks 句柄 | 未传 → bash id 落统一 not-found（文案含来源提示可自纠）；bash 描述静态提法兑现依赖装配 | 装配纪律 |
| 一 ctx 一 tool-bash 装配（一 bash 源） | 重名 kind throw 已 fail-fast | 单装配纪律 |
| waitSettled 为内存轮询（25ms）而非登记簿内 waiters | toolbox 零改动约束（用户二次裁决）下的等价实现——撕裂防护同效（endedAt 判据），代价唤醒粒度 | 本件裁定 |

## 10. 对抗审查处置（两路并行，27 项全处置）

**路 A（契约/语义）**：P1-1 block 缺省反转 → **采纳审查结论：维持 true**（规格/件13/
反自旋三重一致；拉模式裁的是通知机制——§1.1 重写）。P1-2 describe 二值装不下终结错误 →
**采纳**：三态 probe（hit/denied/miss），denied 终结透传（§1.2）。P1-3 缺省归一化缝 →
**采纳**：归一化点=工具层显式传源（§1.2 末条；P1-1 修复后无反转缝）。P2-4 `bt-` 前缀
论据错误 → **采纳**：改 `t-`+12hex 正交论据 + 定序兜底（§1.2）。P2-5 TASK_NOT_FOUND
透传空承诺 → **采纳**：删承诺，统一词表并入 session-scoped 提示（§1.1）。P2-6 bash stop
mid-kill 快照 → **采纳**：whenSettled 收敛后铸终态、超时如实回瞬态（§1.1/§3.1）。P2-7
依赖缺 tools → **采纳**（§2）。P2-8 文档同变过窄 + 缺席装配陷阱 → **采纳**：§7 逐节
清单；缺席态返回文案如实警示（§2/§3.3）。P2-9 落档漏五项 → **采纳**（§9 补齐）。P3-10
verbs 签名重构面 → **采纳**：如实标注（§0/§4-2）。P3-11 whenSettled 释放点枚举错 →
**采纳**：finalize 单点释放 + settled 哨兵（§3.2，与 B-P1-3 合并）。P3-12 main/timeout=0 →
**采纳**：main=denied；timeout=0 零等待语义写明（§1.1）。P3-13 铸文细则/并发声明/对账
锚落位 → **采纳**（§1.1/§5）。

**修订联动（件13 修订A/B，同日）**：agent 源 task_id 收敛为 agentId 精确匹配（name/
[ref] 形态消亡）——§1.1 task_id 形态、§1.2 路由安全论据（裸名撞形面整体消亡，仅剩
agentId/bash id 前缀正交）、probe 实现简化；agent_output/agent_stop 的描述已逐字对齐
规格（本件实施时 task_output/task_stop 沿用同一逐字口径）。

**用户三次裁决（同日）与处置修订**：① bash 不写进 toolbox（toolbox 零改动）；② 无
task-bash 独立包——bash 源适配收进 task-tools 本体（source-bash.ts），工厂参数
`bashTasks` 收句柄，LLM 面只有 task_output/task_stop 两工具。原 B-P0-2 处置（toolbox
内 waitFor 停靠）随工厂参数接线消解；原 B-P1-3 处置（登记簿内 whenSettled/waiters）
改为外置 waitSettled——**判据同为 finalize 产物（endedAt），撕裂快照防护等价**，唤醒
粒度 25ms 落档 §9；A-P2-6 的 stop 收敛语义不变。其余 25 项处置不受影响。

**定稿后自洽压测（同日，方案作者自查）**：① offset×block 交互未定义 → 补 §1.1（缺省恒
true、进度轮询传 block:false、block=true=终态后切片）；② 统一 not-found 文案双源假设 →
§1.1 注明纯源装配下冗余无害；③ offset schema 下界缺失 → §1.1 补 minimum 0；④ 架构不对
称（agent 源经 inject+registerSource、bash 源经工厂参数收进 task-tools 本体、task-tools
包依赖 toolbox）→ **如实认定为三次用户裁决的必然推论而非缺陷**：功能自洽（两源同入
hub、同一对工具、同一路由序），代价是通用层携带一个具体源适配器+两条注册路径——
新源扩展仍走 hub.registerSource（delegation 先例），编辑 task-tools 加工厂参数仅 bash
一例。⑤ 代码级验证：endedAt 仅在 rec.finalize 置位（五路收口）✓、tasks.read 纯查询
（probe-by-read 无副作用）✓。

**实施前二次自洽压测（同日，全链路走查）**：⑥ waitSettled 若按本文件原稿「轮询
tasks.read(...,0)」——read 每次 `Buffer.from(full)` 全量重编码保留缓冲（64MB fullCap ×
40 次/s ≈ GB/s memcpy），「成本可忽略」论断不成立 → §3.2 修正为轮询 `tasks.list()`
（只读 rec 字段）；⑦ stop 铸文对发起前已终态任务裸写 "Stopped" 失实 → §1.1 补
already finished 前缀；⑧ offset 用 Type.Integer 有 validate Kind 派发面未核实的风险 →
§1.1 改 Type.Number（headBytes 防御取整兜底）。边界确认（非洞）：档化/重启后
task_output 如实 404、重生动词是 agent_message（与 Claude Code "a send resumes it from
its transcript" 同构；bash 任务会话级易失同 `/tmp` 实证）；规格「/tasks command」一行
不入描述（本仓无该面，id 来源=spawn 结果与 bash 返回值，not-found 词表已写明）。

**路 B（架构/接缝/假绿）**：P0-1 describe 无法表达 not-owner → 与 A-P1-2 合并处置
（三态）。P0-2 自然装配序 bash 源静默失效 → **采纳**：waitFor 停靠注册（§2/§3.1；迟到
provide 语义已核实支持）。P1-3 whenSettled 释放点漏 evict/stopAll + 撕裂快照 → **采纳**
（§3.2 finalize 单点）。P1-4 破坏面清单不全 + name 未写死 → **采纳**：§5/§6 枚举五文件
+ plugin-manager 面；name "task-tools" 写死（§2）。P1-5 双轨残留（spawn/notify/types
文案）→ **采纳**：§4-4 清理 + grep 锚。P1-6 id 形态论据错误 + 路由序未定 → 与 A-P2-4
合并（定序：kind 字典序）。P2-7 单源异常击穿 → **采纳**：路由层隔离（§1.2）。P2-8 平移
假绿风险（缺省误读/三锚逐字）→ **采纳**：§5 迁移不变式逐条。P2-9 匿名/空 task_id 漂移 →
**采纳**：工具入口前置（§1.1）。P2-10 依赖/inject 缺 → 与 A-P2-7 合并。P3-11 摘源经
effect → **采纳**（§4-3）。P3-12 一 ctx 一 bash 源 → **落档**（§9）。P3-13 两套
not-found 口径 → **采纳**：§1.1 说明。P3-14 旅程装配序探测点 → **采纳**：§5（旅程即
自动探测）。

## 11. 实施记录（2026-09-19）

- **A/B 两步同日完成**：task-tools 新包（tokens/hub/tools/source-bash/plugin/descriptions
  6 源文件 + 5 套单测）；delegation 迁移（工具摘除、agentTaskSource、verbs 签名提参、
  双轨文案清理）；装配面 world + e2e 四文件（toolbox-journey 传 bashTasks、后台段改经
  task_output/task_stop、pollTaskDone 直柄废弃）。
- **迁移发现并修正**：① 方案 §3.2 原稿轮询 read() 全量重编码缓冲——改轮询 list()（§3.2
  已同变）；② stop 已终态铸文加 already finished 前缀（§1.1 已同变）；③ verbs.ownerRow
  签名重构残留一处 execCtx 引用（运行期 ReferenceError 被路由异常隔离吞为 miss——单测
  抓出后修复，测试平移用例即回归锚）；④ delegation-journeys spawn args 残留修订A 已废
  的 name 参数（清除）。
- **顺手清偿**：修订A 遗留 lint 债 5 错 1 警（revive/nameaddr 回调嵌套、contract 可选链）
  一并修复——agent-delegation 归属本件作者。
- **数字**：四门 lint 0-0 / tsc 0 / build ok / test **1178/1178**（93 文件；覆盖率
  lines 93.82 / branch 89.96 / funcs 94.07 / stmts 96.4——task-tools 新包
  97.29/90.9/90.9/100）；e2e 十场景绿。bun.lock 混有他人未提交 session-mailbox 条目——
  不随本件提交，留协调。
- 收口两路对抗审查处置见 §12。
