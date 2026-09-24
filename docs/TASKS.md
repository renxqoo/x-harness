# TASKS：通用任务动词件（件 14）

> 状态：**已实施，并由 TASK-PUSH 修订**（docs/TASK-PUSH-DESIGN.md——task_output 退役：
> LLM 面 = task_stop 单工具；bash 读面 = 日志文件 + [task-notification] 推送。本文件
> §0-§4/§7/§9 为修订后现行规范；§5/§6/§8/§10-§13 为件14 当时的方案/处置/实施记录
> （历史节保留原文）。）
> 原始状态：已实施（方案定稿两路审查 27 项全处置 §10；实施前二次自洽压测 ⑥⑦⑧ 并入；
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
> （TASK-PUSH 修订：上句终态已被推翻——现 LLM 面 = task_stop 单工具，见头部状态注。）

## 0. 目标与边界

消灭「描述承诺任务动词而工具不存在」的契约缺口，并把停动词从 agent-delegation
拆出为跨源通用面。**终态（TASK-PUSH 修订后）**：`task_stop` 由独立插件（@x-harness/task-tools）
提供，经 TaskHub 服务路由到注册的任务源；agent-delegation 注册 `agent` 源；**bash 源在
task-tools 本体内注册**（服务停靠 backgroundTasks，显式 `bashTasks` 参数为覆盖）。**LLM
可见面 = task_stop 一个工具，别无其他**。读面无动词：agent 报告 = [agent-notification]
推送（通知即全文）；bash 输出 = 日志文件（read/grep）+ [task-notification] 完成推送
（task-tools 通知臂）。

不做（落档 §9）：任务枚举/清单工具、跨源统一 id 铸造、任务持久化、remote 会话源。

## 1. 契约

### 1.1 工具面（task-tools 注册；**不留 agent_output/agent_stop 双轨**）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `task_stop` | `{task_id}` | agent 源：cancel+whenIdle 收敛+幂等+停止非销毁（可再 message 复活）+ worktree 清理评估（kept 带路径）。bash 源：两段杀（term→kill）发起 + **whenSettled 有界收敛后铸终态快照**（KILL_GRACE+余量 8s 上界；超时如实回 mid-kill 快照——state=killed/exit=null 属实瞬态，铸文容忍）；**stop 发起前已终态（endedAt 已置）的任务铸文加 already finished 前缀**——裸 "Stopped" 对 completed 任务是谎言 |

**工具入口前置校验**（不进路由）：task_id 空/含换行/调用方无 session → invalid-args；
`task_id === "main"` → `invalid-args:task_id 'main' is not a task`（denied 同款终结）。

返回铸文：
- 停止：源各自终态文案；agent 源保留「可再 message」与 worktree kept 注记。

错误词表（跨源统一）：全 miss → `not-found:<task_id>; no such task in any source (agent
tasks: use list_agents; bash ids come from bash run_in_background; bash tasks are
session-scoped)`（提示语按双源齐备写——纯 bash/纯 agent 装配下他源提示冗余但无害，
静态文案不做装配态分叉）；**源内 definite 错误（not-owner 等）经 denied 通道透传原文案**。命中后
行消失的迟到 not-found（档化/逐出竞态）回落统一词表——两套口径并存如实说明。

并发声明（沿件13）：task_stop = exclusive。

### 1.2 TaskHub 服务与三态路由

```ts
export type TaskProbe =
  | { readonly kind: "hit" }                                       // 本源认领，续走 output/stop
  | { readonly kind: "denied"; readonly reason: string }           // 认领但终结（not-owner/invalid-args）——路由终止，透传源文案
  | { readonly kind: "miss" };                                     // 非本源——续试下一源
export interface TaskSource {
  readonly kind: "agent" | "bash";                                 // 闭合词表
  probe(taskId: string, caller: SessionId | undefined): TaskProbe;
  stop(taskId: string, caller: SessionId | undefined): Promise<Outcome<Text>>;
}
export interface TaskHub {
  registerSource(source: TaskSource): () => void;                  // 重名 kind throw（装配 fail-fast）；注册方自经 ctx.effect 挂摘除
}
```

- **路由序固定**：hub 按 kind 字典序遍历（agent 先于 bash）——不依赖注册时序，同名撞形
  id（`t-<12hex>` 是合法 agent 名）在不同装配下解析一致。
- **路由安全论据（修订A 后收敛）**：bash id = `t-`+12hex（tasks.ts 铸造）、agentId =
  `agent-`+8hex，两前缀正交；agent 源 probe 只认 agentId 精确（regex 锚定），无撞形面。
- **单源异常隔离**：路由层 try/catch 单源 probe/output/**stop** 异常 → 按 miss 计 +
  onWarn 留痕（单源 bug 不打穿另一源；stop 中途抛错如实吞成统一 not-found——onWarn 是
  唯一痕迹，故插件缺省 onWarn 落 stderr，对齐 core 监听器错误缺省 sink）。
- **block 归一化点**：工具层显式 `block: opts.block ?? true` 传源（verbs 内部 `!== false`
  口径与之一致——不依赖双层缺省巧合）。

## 2. 包边界与依赖

```text
packages/task-tools（依赖 core + session[SessionId] + tools[ToolDefinition] +
  tool-bash[BackgroundTasks 类型与适配] + agent-loop[服务停靠——通知臂]）
  tokens.ts（taskHub）
  plugin.ts：createTaskToolsPlugin(options?: { bashTasks?: BackgroundTasks })——
    name "task-tools"，inject ["tools"]（拓扑保证 registry 先行）；provide hub +
    注册 task_stop；bash 源停靠 backgroundTasks 服务（显式参数覆盖）；通知臂二级
    停靠 agentLoopServiceToken（任一缺席对应臂不挂——纯工具世界零通知）
  tools.ts（工具面 + 三态路由 + 铸文）
  cast.ts（commandHead/stateLine——stop 回执与通知首行同源）
  source-bash.ts（bash 源适配器 + 外置 waitSettled——§3）
  notify-bash.ts（完成通知臂：onSettled → 读日志尾部 → notify("bash-task","content")——
    TASK-PUSH-DESIGN §2.4）
  __test__/

agent-delegation：inject 增 "task-tools"（硬依赖：无 hub 装配即失败——stop 是
  子代理面一部分，不静默降级）；verbs.stop 为 agent TaskSource（session 提参签名）。

命令工具包（tool-bash）：登记簿文件化（日志落盘 + onSettled 订阅 + taskLogDir 配置——
  TOOLBOX.md §4 与 TASK-PUSH-DESIGN §2.2 为现行规范）。
```

依赖方向：agent-delegation → task-tools → core/tools/session/tool-bash/agent-loop（软
停靠）；tool-bash 不依赖任务层。无环。装配：bash 后台任务进 task_stop 面 = 服务停靠
共享生效登记簿（缺省；或 `createBashPlugin({ tasks })` 与 `createTaskToolsPlugin({
bashTasks: tasks })` 穿引同一实例）。一 hub 一 bash 源（重名 kind throw fail-fast）。

## 3. bash 源（task-tools 内适配——登记簿文件化后的对接）

- `bashTaskSource(tasks)`（task-tools/src/source-bash.ts）：
  - `probe`：`tasks.list(caller).some(t => t.id === id)` → hit；否则 miss（会话键控即属主面）。
  - `stop`：tasks.stop 发起两段杀 → `waitSettled(...)` 外置收敛 → 终态快照铸文
    （stateLine 与通知首行同源——cast.ts）。
- 读面不在本层：日志文件（read/grep，宿主经 systemRoots 放行——TASK-PUSH-DESIGN §2.3）
  + [task-notification] 完成推送（notify-bash.ts 通知臂）。

## 4. agent-delegation 侧

1. `tools.ts` 只注册 agent_spawn/agent_message/list_agents。
2. `verbs.ts` stop 保留（`caller: SessionId | undefined` 提参）；包 `agentTaskSource(
   verbDeps): TaskSource`——probe = nameaddr 解析 + owner 预检（not-owner → denied；
   `main` → denied invalid-args；解析 miss → miss）。
3. plugin：inject 增 "task-tools"；apply `ctx.effect(ctx.use(taskHub).registerSource(
   agentTaskSource(...)))`。
4. `list_agents` 不动（子代理视图，非任务清单——落档 §9）。
5. 报告读面 = [agent-notification] 推送（AGENT-DELEGATION §5.1——通知即全文）。

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
| 任务枚举/清单工具（/tasks 面） | ~~用户未指令；agent 有 list_agents，bash id 由返回值持有~~ 已由件15 兑现（@x-harness/todo-tools：task_create/get/list/update——规格 Task 清单四动词；详见 docs/TODO.md） | 件15 |
| 跨源统一 id 铸造/全局注册表 | 定序路由已闭环；第二真相反伤 | 不建 |
| 任务持久化/跨重启任务面 | 登记簿生命周期=会话（TOOLBOX.md 既有裁决） | 后续件 |
| remote 会话源（规格 TaskOutput/Stop 覆盖 remote session） | kind 闭合 agent\|bash；remote 无基建 | 云接入件 |
| ~~task_output 不继承规格 DEPRECATED 定位~~ | ~~无文件指针替代路径~~ TASK-PUSH 修订：日志文件路径即一等读面（上游 BashOutput 废弃同路线） | TASK-PUSH 裁定 |
| TaskStop 的 shell_id（规格已弃用参数）与 teammate 形态（name@team） | 不实现 | 本件裁定 |
| bash 后台任务进 task_stop 面 = 服务停靠共享生效登记簿 | 停靠缺省；显式 bashTasks 覆盖（一实例双注册 fail-fast） | 装配纪律 |
| 一 ctx 一 tool-bash 装配（一 bash 源） | 重名 kind throw 已 fail-fast | 单装配纪律 |
| waitSettled 为内存轮询（25ms）而非登记簿内 waiters | toolbox 零改动约束（用户二次裁决）下的等价实现——撕裂防护同效（endedAt 判据），代价唤醒粒度 | 本件裁定 |
| contract.test 逐字对账读绝对路径 /Users/wrr/work/claude-tool/…（规格在本仓外无副本） | 其他 checkout 上该用例必挂——机器绑定是既有取舍（件13 起即如此） | 后续件（规格入仓或环境探测） |

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

## 12. 收口两路对抗审查处置（2026-09-19，路A 契约/语义 + 路B 并发/生命周期/假绿）

**路A（2 P2 + 8 P3）**：P2-1 TASKS §1.1/§1.2 task_id 形态未随修订A 收敛 → **采纳**（本版已改
写：agentId 精确 + 前缀正交）。P2-2 AGENT-DELEGATION §2.1/§5.1/§5.2/词表四处残留修订A 前
名字机制 → **采纳**（§5.2 收敛三分支、ambiguous 词目删除、pattern 依据与 main 信封 from 改
agentId 口径）。P3-3 表格被注记行截断 → **采纳**（注记移表尾；list_agents 行格式改双形态
如实）。P3-4 §7 承诺 §12/§14/§15 加注仅 §12 落地 → **采纳**（两节尾注指向 §17）。P3-5 描述
头注偏离计数偏低 → **采纳**（改五类偏离清单）。P3-6 源侧死缺省 `?? true` → **采纳**（改
`=== true`——tokens 注释「源不再猜缺省」成真）。P3-7 probe-by-read 双重全量重编码 → **采纳**
（probe 改 list().some——§3.1 同变；与路B P3-2 合并）。P3-8 stop 收敛窗 evict 分支无测试 →
**采纳**（补「settle 窗内逐出 → not-found」用例）。P3-9 stop 异常隔离超方案字面 → **采纳**
（§1.2 口径扩为 probe/output/stop，取舍明示）。P3-10 UTF-16 截断劈代理对 → **采纳**
（commandHead 改码点截断）。

**路B（2 P2 + 6 P3）**：P2-1 delegation 摘除序注释与 LIFO 实序相反（关箱后仍有 drain/心跳拍
窗口）→ **采纳**：consumer.shutdown 改经 pendingEffects 注册于心跳/drain **之前**——回卷序
成真「停 drain → 停心跳 → 结算+关箱」（件13 遗留，本件清偿）。P2-2 缺省装配下单源异常零
留痕 → **采纳**：插件缺省 onWarn 落 stderr（对齐 core 缺省 sink）。P3-1 already-finished
TOCTOU（before 预查与 stop 发起之间自然完成）→ **采纳**：判据改 `initiated.value.endedAt`
（发起返回的同步快照），删 before 预查。P3-2 与路A P3-7 合并处置。P3-3 迟到 miss 以
`not-found:` 前缀耦合源词表未落契约 → **采纳**（TaskSource 接口注释写为协议事实；
routing.test 迟到用例即锚）。P3-4 `exit=(143|137|null)` 放宽 → **采纳**（收紧为
`(143|137)`——null 属未收敛）。P3-5 插件层双装配 fail-fast 无用例 → **采纳**（plugin.test
补 rejects 用例）。P3-6 contract.test 读绝对机器路径规格源 → **落档 §9**（规格在本仓外、
无仓内副本；机器绑定是既有取舍，后续件再治）。

**核过无偏面（两路一致）**：语义保真（block/timeout/超时快照/reportCap/not-owner/幂等/
worktree kept 逐字等价）、三态路由（denied 不遮蔽/统一词表/迟到回落/异常隔离/归一化点）、
描述真实性、双轨清零、toolbox 零改动、e2e 真接线（非直柄换皮）、迁移断言零弱化（三锚
逐字 + block 显式化）、apply 中途 throw 回卷、资源无泄漏。

**状态注记**：审查进行中用户将工作区整体提交为 `c39480e`（"fix: bug"，含本件全部成果与
他人 llm/agent-loop 在途变更）——本处置批次以只含本件文件的新提交落地。

## 13. 服务停靠（2026-09-19 用户裁决「修改」——b08a77f 拆包后地形变化）

手工穿引（`createBashPlugin({tasks})` + `createTaskToolsPlugin({bashTasks: tasks})`）是件14
三次裁决时「toolbox 零改动 + 无 bash 包」约束下的最小接线。`b08a77f` 把 bash 拆为独立包后
该约束消亡，缺省共享改为服务停靠（同 execEnv 先例：提供方 provide、消费方停靠）：

- **tool-bash**：`createBashPlugin` 把生效登记簿（外穿实例或自建）provide 为
  `backgroundTasks` 服务（attach 期——env 解析后，装卸同回卷）。
- **task-tools**：显式 `bashTasks` 参数保留为覆盖（优先级高于停靠）；缺省
  `ctx.waitFor(backgroundTasks)` 停靠——tool-bash 在场即共享，不在场（纯 agent 形态）不
  注册 bash 源、bash id 落统一 not-found（语义不变）。**可选依赖不 inject**：inject 缺席
  =装配失败，会把 bash 变成任务动词的前提。停靠摘除经 ctx.effect；dispose 竞态以停靠旗
  收口；显式参+停靠双注册 = 重复源 fail-fast（dup-kind throw 响亮）。
- **装配面**：`createBashPlugin()` + `createTaskToolsPlugin()` 两行裸调用即共享（装配序
  无关——real.ts/toolbox-journey 已随迁）；一 hub 一 bash 源 fail-fast 兜底不变。

§2 依赖图注与 §9「装配纪律」行的手工穿引口径由本节取代；显式参数路径（自定义限额/宿主
自管生命周期）继续有效。测试：task-tools plugin.test 停靠/序无关两用例 + tool-bash
service.test 自建与外穿双形态。

## 14. TASK-PUSH 实施记录（2026-09-24）

- 删除面：task_output 工具/schema/描述、TaskSource.output、TaskOutputOptions、
  verbs.output/reportText/reportHead/raceIdle、reportDelivered 整链（lineage/spawn/
  revive/notify）、tasks.read/TaskRead/headBytes/spill。
- 新增面：tool-bash log-sink（单写队列/ANSI-CR 状态机/写帽/IO 失败面）+ onSettled
  + taskLogDir；task-tools notify-bash 通知臂（双停靠）+ cast 铸文共享；tool-core
  systemRoots；harness toolboxKit taskLogDir 透传 + taskLogsRootOf；host-hub
  session-delete 级联清理（前置顺序裁决）+ worker 装配；e2e toolbox-journey 推送制改写。
- 文档同变：TOOLBOX/AGENT-DELEGATION/AGENT-MESSAGE/SUBAGENT-FAILURE-NOTIFICATION/
  CLI/TODO/PLUGIN-AUTHORING + 本文件现行节改写（历史节保留）。
- 方案与对抗审查 28 项处置：docs/TASK-PUSH-DESIGN.md。
