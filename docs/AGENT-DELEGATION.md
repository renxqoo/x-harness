# AGENT-DELEGATION：子代理与跨会话通信终态（件 13）

> 状态：**方案定稿**（两路对抗审查 41 条发现全处置，见 §14）
> 级别：高（agent-delegation 整包重写 + session-mailbox 新包 + agent-loop/session/session-persistence/
> permission/toolbox/sandbox-local/system-prompt 七处接缝）
> 规格层级（本件特设，先于一切）：**外部规格 = `/Users/wrr/work/claude-tool/agent-and-background-tasks.md`**
> （Claude Code 子代理与后台任务五工具文档）+ §1 四项用户裁决；旧实现不再是规格，但其已验证
> 机制（X1–X20 语义、fork 净化、通知臂/占槽拆分、孤儿收养）作为保留机制映射表（§9.3）继承。

## 0. 动机与终态定义

现状：五工具描述已逐字对齐规格，但参数面/行为面是进程内子代理子集，描述承诺大量不存在的能力
（task_id/block/timeout、to/message/summary/notify_when_idle、跨会话、isolation、system-reminder
类型注入），契约自相矛盾。本件目标 = **消灭矛盾**：按规格语义重写 agent-delegation 到终态，
不留过渡版本、不留兼容双轨。

终态边界（由 §1 裁决确定）：本机单进程子代理全语义 + 本机跨进程会话通信；云端/Remote
Control/agent-team/统一后台任务体系（bash 后台、输出文件指针、/tasks）不做，落档 §13。

## 1. 用户裁决记录（2026-09-19，AskUserQuestion 落档）

| # | 裁决点 | 决定 | 派生后果 |
| --- | --- | --- | --- |
| U1 | 跨会话通信边界 | **+本机跨进程**：文件系统邮箱 + peer 发现，本机多个 harness 进程可互发 | liveness/回收/原子投递协议（§5.3）；云端/Remote Control/agent-team 落档 |
| U2 | 统一后台任务体系 | **不并入**：TaskOutput/TaskStop 只管子代理任务 | 描述不得承诺 bash 任务/输出文件指针//tasks（§2.3）；任务体系归后续件 |
| U3 | 工具命名 | **保留蛇形名**（agent_spawn/agent_message/agent_output/agent_stop/list_agents） | descriptions.ts 弃逐字原文，改写为真实语义（引用本仓工具名与参数） |
| U4 | 类型定义来源 | **仅 .md 文件**（frontmatter + 正文=子 system prompt），弃编程式 types | DelegationOptions.types 删除（零兼容）；类型清单注入通道新建（§7.2） |

## 2. 外部契约

### 2.1 工具参数面（终态；修订A 去名 + 修订C 读停迁出后余三工具）

| 工具 | 入参 | 行为要点 |
| --- | --- | --- |
| `agent_spawn` | `{description, prompt, subagent_type?, model?, isolation?}` | description 必填（3-5 词任务简述）；prompt 必填非空；subagent_type=已注册 .md 类型名或保留名 `fork`，缺省=untyped 通用代理（如实表述，非规格的显式 general-purpose 类型）；model 按次覆盖、**任意 model-id 字符串**（规格是 Claude 专属 enum，本仓开放——差异标注）；isolation 仅 `"worktree"`（§8）。返回 `{agentId, sessionId}` + 反轮询引导；后台运行，完成时 `[agent-notification]`（§5.1） |
| `agent_message` | `{to, message?, summary?, notify_when_idle?}` | to 必填、**单行**（pattern `^[^\n\r]*$`——agentId/box 名为无换行原子串）；message **可选**（省略+notify_when_idle=纯订阅；给值时 pattern `^[\s\S]{0,300}$`，长内容走文件中转）；summary ≤200 **超长截断不拒**、仅出现在发方工具结果回显——**不进信封不落对端**（规格 not transmitted；本仓无 transcript 行展示面，等价物=结果回显）；notify_when_idle 仅根会话且仅跨进程 box 目标（§5.4）。对应规格 SendMessage 语义（进程内 + 本机跨进程） |
| `list_agents` | `{}` | 行格式双形态：子代理行 `kind=subagent <agentId> session=<id> type=<t> depth=<n> status=<running\|idle\|stopped>`；本机会话行 `<box名> [<ref>] kind=local-session status=<...>`；两类对象：本会话子代理 + 本机其他会话（§5.3）；status 是**本仓生命周期词表**（running=规格 busy，命名差异落档 §13），与 turn/end reason 词表（completed/aborted/…）是两套口径；跨进程行 status 来自 manifest（只反映对端宿主 main 会话，粒度落档 §13）。规格 channel/q 占位参数不实现（落档） |

（读/停动词已迁出——件14 修订C：`task_output`/`task_stop` 由 @x-harness/task-tools 提供，
经 TaskHub 路由到 agent 源（本包 agentTaskSource 注册）与 bash 源；schema/铸文/统一
not-found 词表见 docs/TASKS.md §1。）

错误词表（判别联合 reason，中性英文，统一 `area:detail`）：`invalid-args:*`（参数形状/未知
类型/to 含换行/notify_when_idle 越权或非 box 目标）、`not-found:*`（寻址落空，带形态与清单
引导）、`not-owner:*`、`denied:max-depth|shutting-down`、`busy:max-concurrent`、
`spawn-failed:*`、`not-live:*`（跨进程对端死）、
`aborted:*`（execute 内断信号防线，现状继承）。

### 2.2 限额与预算

maxDepth 缺省 3 / maxConcurrent 缺省 10（occupied 口径：登记占、完成通知/stop 释、message
复活复占）/ reportCap 缺省 8000 / 通知摘要 200 / **maxResident 缺省 32**（idle 子驻留上限，
最旧档化：dispose 子会话（WAL 在盘）+摘行，配合 §6.2 惰性复活天然可恢复——防完成子无限
驻留累积）/ mailbox 定时参数全部可注入（pollIntervalMs 300 / heartbeatMs 10_000 /
graceMs 30_000 / staleMs 7d / now()——测试确定性收口，§11）。

### 2.3 description 改写原则（U3 派生）

descriptions.ts 保留独立常量文件形态，文本全部重写：以本仓蛇形工具名与真实参数为准；
继承规格的行为规范内核：委派后勿自查、禁编造未完成代理结果、最终报告需主会话转述、
**转述时不引用原文**（已渲染给用户）、**回复跨会话消息时拷贝其 from 为 to**、权限洗白红线、
notify_when_idle 反轮询（禁循环 list_agents/「好了吗」）、`[agent-notification]` 等待语义、
idle 通知标签统一 `[Cross-session idle notice]`。**禁止**出现不存在的承诺（/tasks、bash 任务、
输出文件路径、云端、teammate、DEPRECATED）。改写后 description 与 schema 逐字段可对账
（§11.2 双向对账）——假绿抽查硬检查项。件14 修订C 起 output/stop 的对账对象随工具迁
task-tools 包内（跨源口径非逐字面，锚词对账见 docs/TASKS.md §5）；本包对账面=三工具。

## 3. 架构与包边界

```text
┌─ agent-delegation（重写）──────────────────────────────────────────┐
│ plugin.ts(装配) spawn.ts(决策流) verbs.ts(output/stop/list)        │
│ nameaddr.ts(寻址解析) lineage.ts(双索引血缘) notify.ts(通知)        │
│ types-loader.ts(.md) worktree.ts(隔离) mailbox-consumer.ts(跨进程) │
└────────────┬───────────────────────────────────────────────────────┘
             │ use
┌─ session-mailbox（新包，仅依赖 core）──────────────────────────────┐
│ box.ts(开箱/认领/manifest/心跳/关箱) send.ts(原子投递/抢占 drain)   │
│ discover.ts(peer 发现/墓碑两步回收) subs.ts(idle 订阅/结算)         │
│ 纯文件协议：tmp+rename 原子、单文件单消息（§5.3）                    │
└────────────────────────────────────────────────────────────────────┘
接缝（同提交，各包内最小扩展）：
1. session：CreateSessionOptions 增 agent 元数据透传（makeHeader 扩展落盘通道——
   store.ts birth 路径），SessionHeader 增 `agentName?/agentType?/agentDepth?`
   （复活锚：名字/类型/深度冗余落盘，免链回溯）
1b. session-persistence-jsonl：SessionArchive 增 `listHeaders()`（只读 header.json 的
   轻量投影——复活扫描与 discover 不读全卷）
2. agent-loop：无新动词（block 等待用现有 whenIdle；类型清单走边沿注入快照）
3. permission：GrantsRegistry 增 `setRootOverride(session, dir)` / `rootOverrideOf(session)`；
   `addExtraRoot` 增守卫——带 override 的会话拒绝原根子树路径入 extraRoots（防权限批准
   打穿隔离）
4. toolbox：paths.ts PathGate rootOverride 全链——admit 增 override **替换** this.root
   （非叠加）、rebaseToRoot 词法基随 override 切换、override 根 realpath 双形归一
   （macOS /var→/private/var，对齐 extraRoots 做法）、admitSession 会话面统一入口
   （守卫根子树的 extraRoots 批准过滤）；**bash 无路径参数——缺省 cwd =
   rootOverrideOf(session) ?? gate.root**（cwd 即会话根）；四工具透传
5. ~~system-prompt 依赖~~：类型清单已迁边沿注入快照（§7.2，docs/TAIL-SNAPSHOT-CHANNEL.md）——delegation 不再注入 system-prompt
6. sandbox-local：fence 增会话级 rootOverride——writable 集合以 override 替换 base.root、
   protectedPaths 按 override 根重算（worktree 的 bash 命令体写面执法，§8.2）
```

依赖方向：agent-delegation → session-mailbox / agent-loop / session / tools / permission(grants
token) / system-prompt（**inject 扩为 `["session","tools","agent-loop","permission",
"system-prompt"]` + mailbox 服务**）；session-mailbox → 仅 core。mailbox 时间参数与 now()
经 options 注入（§2.2）。

## 4. agent 管理控制面（怎么管理控制所有 agent）

### 4.1 生命周期状态机（单子代理）

```text
spawned(瞬态，登记即 followup) → running ──idle+armed──> [agent-notification] → idle(槽释放)
idle ──message──> running（复活复占槽；唤醒入口重验父存活，缺位→孤儿收养）
running|idle ──task_stop──> stopped(幂等；槽释放；可 message 复活)
idle 驻留超 maxResident → 档化（dispose 子会话+摘行；可按 agentId 惰性复活，§6.2）
任意 ──插件 teardown──> disposed（级联 cancel+whenIdle+dispose；tearing-down 通知门先行；
  worktree 清理评估；mailbox 序列见 §5.3 关箱）
进程消失 ──重启──> 内存行丢失 → 惰性重建（§6.2）
```

不变量：① occupied 计数与 running/复活严格对应（通知与 stop 是仅有的两个释槽点）；
② armed 只在 running 置位、通知即复位（防 idle 双通知）；③ tearing-down 置位后通知门丢弃
一切（级联 cancel 的 abort 通知不得 steer 复活父）；④ 孤儿子收养（父先 dispose →
cancel+dispose+摘行），唤醒入口（message）同样重验；⑤ 三索引（agentId/sessionId/name）
单一 register/drop 出口同改。

### 4.2 lineage 数据结构（重构）

`Map<agentId, ChildRow>` 主索引 + `Map<sessionId, agentId>` 副索引 + `Map<name, agentId[]>`
**agentId 铸造 = `agent-<8hex随机>`（修订A：唯一身份，无名索引）
（crypto 随机，进程内唯一且跨重启不撞）**；`[ref]` = agentId 的 8hex 段尾 6 位（hex 形态，
规格形）；box ref = manifest.bootId 尾 6 hex。ChildRow 增：`worktree?: string`。

### 4.3 ChildRow 字段终态

`{agentId, sessionId, name, type, parent, depth, occupied, armed, running, stopped, work?, worktree?}`（work = spawn description 任务摘要，header.agentWork 持久锚——复活回填，旧档案可能缺席）。
**live 定义：内存行存在即 live（含 stopped——可复活）**，同名消歧计数按此口径。视图投影
status：running→`running`；stopped→`stopped`；否则 `idle`（停止后复活如实显示 running）。

### 4.4 属主边界（管理面红线）

- `task_output` / `task_stop`（agent 源——件14 经 task-tools 暴露）：**仅 owner**
  （callerSession === row.parent），task_id = agentId 精确（**不支持 main 与跨进程**）；
  not-owner 经 probe denied 通道透传，源内 not-found 回落 task-tools 统一词表。
- `agent_message` / `list_agents`：**开放寻址**（规格 SendMessage 语义）——进程内任意 live
  子代理（含兄弟）、本机任意 live 会话（box 域，仅会话级——**子代理不跨进程直接寻址**，
  见 §5.3）；子代理可用 `to:"main"` 回父（§5.2 分支 1）。
- `notify_when_idle`：仅根会话 + 仅跨进程 box 目标；进程内目标 → invalid-args（进程内有
  天然完成通知）；本进程未开 box → invalid-args:no-mailbox。
- 跨会话权限洗白红线：description 行为规范层执法；机械执法落档 §13。

## 5. agent 交互协议（agent 之间如何交互）

### 5.1 进程内（父 ⇄ 子）

- **父→子**：`agent_message` → 子 steer（busy→步边界排队；idle→唤醒起新轮）。spawn 的
  prompt 走 followup（next-turn 队首）。
- **子→父（main 通道）**：子调 `agent_message{to:"main"}` → 插件路由 steer 到父会话，文本
  包装 `<cross-session-message from="<子 agentId>">…</cross-session-message>`。父
  busy→步边界；父 idle→唤醒。父已 dispose → not-found。
- **完成通知**：agentStatus 监听 → armed/idle → 子 WAL 末 turn/end 全字段透传
  （kind/message/code/cause/reason——`docs/SUBAGENT-FAILURE-NOTIFICATION.md`）+ 本轮
  assistant 摘要 ≤200 + `session:` 行（子会话档案指针）+ usage → `[agent-notification]`
  steer 注入父 → 释槽。异常终态显式成败：completed → `finished: completed`；aborted →
  `stopped: <cause>`；error/max-tokens/blocked/interrupted → `failed: <原因句>`
  （max-tokens 区分有无摘要、error 带 message/code、blocked 带 preStep reject 原因、
  interrupted 为 repair 残卷铸造态——docs/SUBAGENT-FAILURE-NOTIFICATION.md 词表）——
  主代理不猜、不轮询、不解读状态词。子会话缺档时投递 `session-archived` 占位通知
  （如实，不再静默，session 行照带）。
- **兄弟互发**：`agent_message{to:"<兄弟agentId>"}`，同 steer 路径。

### 5.2 寻址解析算法（nameaddr.ts，`to` 的唯一解析真源）

```text
解析(to, callerSession)（修订A 收敛为三分支）:
1. to === "main"   → caller 有 parent? 父会话(进程内 steer) : invalid-args(main 仅子代理可用)
2. to 匹配 ^agent-[0-9a-f]+$ → lineage 精确命中；未命中 → 转 3
   （跨重启复活经 agent_message 回退链——档案按 header.agentId 复活，§6.2）
3. 非 agentId 形 → mailbox discover 裸名（box 名）：唯一 live box → 跨进程投递；
   无 → archive 惰性重建（仅 caller 自己的历史子代理，§6.2）：header.agentId 匹配 →
   resume 复活（沿用原 id）→ 命中；否则 not-found（附 agentId 形态与 list_agents 引导）
```

task_output/task_stop（agent 源）的 task_id = agentId 精确（nameaddr 分支 2；不支持 main
与跨进程），再过 owner 校验（§4.4）。**跨进程域只解析会话（box）**：`to` 落在 box 域 = 消息进对端进程的宿主 main 会话；
子代理跨进程发送以父 box 为出址（from=父 box），回信进父进程 main 会话——规格「子代理
的发送走父会话地址、回复送回父会话对话」原文语义。

### 5.3 跨进程（本机会话 ⇄ 会话，session-mailbox 文件协议）

**目录布局**（root：`X_HARNESS_MAILBOX_DIR`，缺省 `~/.x-harness/mailbox`；目录 0700）：

```text
<root>/<box-name>/
  manifest.json     # {pid, bootId, status:"running"|"idle", updatedTs}——原子重写（tmp+rename）
  inbox/<ulid>.msg  # 信封（写方先写 <ulid>.tmp 再 rename 发布——读方只见完整文件）
  inbox/<ulid>.proc # 收方 rename 抢占标记（单读者保证）；启动时清残留
  subs/<from>.json  # idle 订阅 {from, ts}（原子重写；一次性，fire 后删）
```

**信封**：`{"id":"<ulid>","from":"<box>","to":"<box>","message":"…","ts":<ms>,"kind":"message"|"idle-notice"|"idle-expired"}`
（无 summary——不传输）。from 恒为发送方宿主 box 名。

**原子性三则**：① 信封发布 tmp→rename（收方永不见半写文件）；② manifest/subs 一律
tmp+rename 原子替换；③ parse 失败语义——信封坏=丢弃+日志一条（at-most-once 投递语义，
crash 窗口 `.proc` 残留清扫=接受丢失，如实声明）；manifest 坏=退回 `kill(pid,0)` 判活。

**开箱/关箱/认领**：开箱 mkdir 排他；EEXIST → 读 manifest：pid 死或超宽限 → **认领**
（重写为自己的 pid/bootId，清 inbox/subs 残留）；pid 活 → throw（真重名）。正常退出关箱
（插件 dispose 链末步）：结算 subs（§5.4）→ 删 box 目录——7d 陈尸回收只兜异常崩溃。
manifest.status：本进程 agentStatus 边沿**即时重写**（不等心跳）；心跳（heartbeatMs）只
touch updatedTs。判活 = `kill(pid,0)` 成功或 updatedTs < graceMs（墙钟，NTP 回拨风险落档
§13；bootId 消费者=[ref] 铸造与认领，不参与判活——pid 复用窗 30s 接受，落档）。

**投递时序**（规格对齐：消息在对端下一工具轮消费）：**一 box 一 drain 循环**
（pollIntervalMs，进程存活期常驻，`ctx.effect` 挂接——dispose 序列钉死「停 drain → 停心跳
→ 结算 subs → 关箱删目录」，全部定时器 unref 不阻退出）：readdir inbox → 逐个
`rename(x, x.proc)` 抢占成功者读信封 → **路由：信封一律 steer 到宿主 main 会话**（包装
`<cross-session-message from="…">`）→ unlink。steer 异常（宿主恰在封存）→ 捕获+日志+继续
循环（drain 永不被单封击穿）。busy 天然步边界消费；idle 唤醒。

**liveness 与回收**：发送前对目标 box 判活，死 → `not-live:<box>`。discover 惰性回收：
判陈尸（pid 死且 mtime > staleMs）→ **墓碑两步**：rename 目录到 `<root>/.tomb/<box>-<ts>`
→ 重读 manifest 验 pid 与判定时一致（防回收/重开竞态删活箱）→ 删墓碑；不一致 → 还原。
回收时结算该 box 的 subs：向各 from 投 `kind:"idle-expired"`（`[Cross-session idle notice]
subscription expired: <box> gone`）——规格「恒一条通知」的 expired 分支。

**box 命名**：装配层指定（宿主 main 会话对外名）；真重名（活 pid）构造期 throw。

### 5.4 notify_when_idle（一次性空闲订阅）

**双向闭窗**（错过 idle 事件窗口的修复）：订阅方（根会话）发起时——(a) 写 subs 前查目标
manifest.status，已 idle → **立即投 notice 不写订阅**；(b) 写 subs 后复查一次目标状态，
idle → 结算（覆盖 (a) 之后的翻转）。线性化点：订阅生效 = subs 文件 rename 发布瞬间；
idle 判定 = 目标进程 manifest.status 值。

时序：带 message → 先投信封再写 subs（两步非原子，一次性尽力语义，注明）；纯订阅 =
message 省略 + 只写 subs。目标会话转 idle（agentStatus 边沿）或进程 teardown 时：读全部
subs → 逐个向 from box 投 `kind:"idle-notice"`（`[Cross-session idle notice] <box> idle
at <ts>`）→ 删订阅文件（一次性）。from 已死 → 投递失败仍删。目标异常死亡 → 回收期
idle-expired 结算（§5.3）。收到的 notice 按普通信封消费（steer 注入）。**反轮询执法**：
description 行为规范。

## 6. 名字、复活与重启重建

### 6.1 名字注册（进程内）

spawn 时 name = 显式 name 参数 ?? description slug（小写、`[^a-z0-9-]` 折叠、截 24 字符、
**空则回退 `agent-<8hex>` 随机段**——中文简述折叠为空的误路由防线）。同名人共存（名索引
数组）。name 概念已随修订A 消亡——agentId 是唯一键。

### 6.2 archive 惰性重建（「名字在完成后仍有效」的跨重启形态）

接缝 1 落盘 `header.agentName/agentType/agentDepth`。寻址落空（§5.2 第 5 步）→
`archive.listHeaders()` 过滤 `parentSession === caller && agentName === name`（多个 →
ambiguous）→ `loop.resume(sessionId, agent)` 重建 options：**按落盘 agentType 从 .md 重取
systemPrompt/model/tools 白名单**（类型文件已删/改 → fail-closed 拒复活
`not-found:type-def-missing`，不降级复活）；depth 取落盘冗余（不链回溯）；row.worktree
在 → **重放 grants/fence rootOverride**（复活不丢隔离，§8.2）→ `steer(message)` 唤醒 →
重建 ChildRow（occupied=true/armed=false；work 自 `header.agentWork` 回填——旧档案
无此字段即缺席）。resume 单写者边界：依赖「会话归父进程所有 +
box 唯一」的占有模型（SESSION-RESUME §1.4）——**如实声明该闭环依赖宿主部署纪律**（对端
不开同 box 无法机械拦截跨进程双开；档案级锁落档 §13）。

## 7. 类型系统（仅 .md，U4）

### 7.1 文件规格与加载器（types-loader.ts）

目录（优先级降序，同名前者胜）：`X_HARNESS_AGENTS_DIRS`（冒号分隔）> `<cwd>/.x-harness/agents/`
> `~/.x-harness/agents/`。文件格式：

```markdown
---
name: explore            # 必填，须与文件名一致；保留名 fork/main 拒
description: 只读搜索代理    # 必填，注入清单用（§7.2）
model: <model-id>          # 可选
provider: <provider-id>    # 可选
tools: read, grep, bash    # 可选白名单（逗号分隔；缺省=全集；含未注册名 spawn 时拒）
---
正文 = 该类型子代理的 system prompt（空正文合法=装配默认）
```

frontmatter = 自写扁平 `key: value` 解析器（无嵌套、无新依赖）；垃圾输入（缺必填键/保留名
冲突/值类型不符）→ 该文件拒注册 + 装配日志一条（中性英文），不 throw 不崩。加载时机：
插件 apply 全量 + **agentStatus running 边沿探测**（每 kick 一次；现状无 turn 前钩子，
同步装载（types-loader 同步 fs）——变更 → 重载 → 快照 render 当轮拾取（§7.2）。
保留类型 `fork` 内建；`main` 是地址非类型，文件名占用即拒。

### 7.2 类型清单注入通道（边沿注入快照——docs/TAIL-SNAPSHOT-CHANNEL.md）

delegation 经 `createTailSnapshot` 共用原语在 running 边沿幂等注入 user/message 快照：
`<snapshot kind="agent-types">` 信封 + 作废声明 + `<system-reminder>\nAvailable agent
types:\n- name — description (model)\n…\n</system-reminder>` 体。render 内同步探测
（types-loader 同步 fs，fingerprint 门控）+ 渲染——类型变更**当轮 kick 可见**；内容维
幂等（同文不重复注入，变更后尾部新条、旧条靠作废声明收敛）。机制事实（如实）：一切
经 loop kick 的会话（含 untyped 子、fork 子、空正文类型子、复活子）都会看到清单——
全局边沿的自然结果；无类型零注入。此为本仓机制选择，非规格要求。锚点不再含类型清单
（易变事实出锚点——漂移不打穿缓存前缀）。

### 7.3 model 覆盖序（规格优先级；无 default subagent model 配置层，落档 §13）

`spawn.model`（按次）> `type.model`（.md）> 父 `options.model` > 父末次 request/header
折叠。fork：`model` 参数忽略，固定父模型（规格原文）。provider 同序。reasoning effort：
AgentOptions 无字段，落档 §13。

## 8. isolation: worktree（§2.1 唯一 isolation 值；remote 落档）

### 8.1 创建（worktree.ts）

路径 = **repo 外同级** `<repoParent>/.x-harness-worktrees/<repoName>-<agentId>`（避开 .git
受保护区与主仓工作树污染）。`git rev-parse --git-dir` 确认在仓 → `git worktree add -b
x-harness/<agentId> <path> HEAD`。**spawn 侧 git 调用经互斥队列串行**（并发 spawn 依赖 git
内部锁未验证，串行消除风险）。任一步失败 → spawn 拒（`spawn-failed:worktree <原因>`），
半建产物清理（worktree remove + branch -D 兜底）。

### 8.2 授权面（双层执法 + 如实降级声明）

- **工具参数面（恒执法）**：`grants.setRootOverride(childSession, path)`（接缝 3）→
  read/write/grep/bash(workdir) 经 PathGate（接缝 4）：override **替换**原根——主仓不可
  达；bash 缺省 cwd = override 根。`addExtraRoot` 守卫拒绝原根子树（防权限批准打穿）。
- **bash 命令体写面（fence 在场时执法）**：接缝 6——sandbox fence 会话级 rootOverride，
  writable 集合替换 base.root、protectedPaths 按 override 根重算 → worktree 子的 bash
  命令体内绝对路径写主仓被内核层拒绝。
- **降级边界（如实）**：未装配 sandbox-local 的部署，bash 命令体路径不在隔离执法面
  （仅工具参数面隔离）——description 行为规范层禁止 + §13 落档。

### 8.3 清理时序（规格「无改动自动清理」）

评估时机：子 dispose（teardown 级联/孤儿收养/驻留档化）、`task_stop`、**启动期对账清扫**
（装配时扫描 worktree 根目录：无 live 行对应的目录——status --porcelain 空 → worktree
remove + branch -D；非空 → 保留+日志——父进程崩溃泄漏兜底）。评估 = `git -C <path>
status --porcelain` 空 → remove+branch -D；非空 → 保留，stop/通知文案带路径。完成通知
不触发清理（子驻留可复活，worktree 即其工作区；驻留档化时评估）。

## 9. 旧实现审计与逐模块裁决

### 9.1 审计结论（四标准逐文件，含用户点名的删除/重构项）

| 文件 | 问题（标准①正确性/②契约/③质量/④依赖） | 级别 |
| --- | --- | --- |
| plugin.ts:123 | ①④ `seed: seed as never` 不安全 cast——CreateSessionOptions.seed 类型摩擦的遮罩 | P1 |
| plugin.ts:47-54 | ③ rowOf 以 `[...values()].find` 线性扫 agentId——血统表键位选错 | P1 |
| plugin.ts:21-33 | ③ `countValue` 命名失真（校验非负安全整数，非「计数」）；reportCap>0 特判折叠绕 | P3 |
| plugin.ts 整体 | ③ 258 行装装配+决策流+四动词+视图四件事，违「一文件一件事」 | P2 |
| notify.ts:93-94 | ① 子会话缺档 → 静默 return，父永不知 completion 丢失 | P2 |
| tools.ts | ③ schema `args as {…}` 窄化 4 调用点 5 处表达式（TypeBox 泛型未对齐） | P3 |
| types.ts | ② DelegationOptions.types 与 U4 裁决冲突（删除）；ChildView 随 §2.1 重铸 | 裁决 |
| descriptions.ts | ② 逐字原文与 U3 裁决冲突（改写，§2.3） | 裁决 |
| lineage.ts / notify.ts 核心机制 | 四标准通过（forkSeed 重铸/inheritDial/narrowTools/armed-occupied/收养处置） | 保留 |
| 死代码扫描 | 全包无未消费导出/不可达分支；无旧路径别名残留 | 无 |

### 9.2 逐模块裁决表

| 旧模块 | 裁决 | 去向 |
| --- | --- | --- |
| plugin.ts 装配骨架 | 重构 | 拆八文件（§3）；inject 扩 `["session","tools","agent-loop","permission","system-prompt"]` + mailbox |
| spawn 决策流（resolveType→depth→concurrent→buildChild→断信号防线） | 复制+扩展 | spawn.ts；类型解析改 .md 源 + model 覆盖序 + name 铸造 + isolation 分支 + git 串行队列 |
| lineage.ts 血缘 | 重构 | 双索引 + name 索引 + agentId 8hex + worktree 字段；forkSeed/recastSurface/inheritDial/narrowTools 原样迁移 |
| notify.ts 通知 | 复制+微修 | armed/occupied/收养/tearing-down 门全保留；缺档占位通知 + 唤醒入口重验父存活 |
| verbs（message/output/stop/list） | 重写 | nameaddr 寻址 + 开放寻址/owner 边界 + block/timeout + main 通道 |
| tools.ts 工具面 | 重写 | §2.1 参数面 + TypeBox 泛型对齐（删 as 窄化） |
| descriptions.ts | 重写 | §2.3 改写原则 |
| types.ts | 重写 | 终态 options：{agentsDirs?, mailboxDir?, mailboxTiming?, maxDepth?, maxConcurrent?, reportCap?, maxResident?} |
| 新增 | 新写 | session-mailbox（box/send/discover/subs）+ nameaddr + types-loader + worktree + mailbox-consumer |

### 9.3 保留机制映射表（旧 → 新，行为等价锚点）

X1 后台 spawn/X2 完成通知/X4 收件箱三态/X5 停止可续/X7 深度门/X8 并发占槽/X10 reason 全集
透传/X11 报告 cap/X13 同名共存/X14 fork 净化（surface 重铸+末 turn/end 切口+system 特赦）/
X15 白名单沿树收窄（registry 会话层 restriction——W2A 后唯一真相；header 投影+执行面双断言保留）/X17 未知类型带清单/X19 stop 幂等/X20 execute
内断信号防线——逐条进 §11 迁移矩阵。

## 10. 删除清单（本次提交内物理删除）

1. `DelegationOptions.types` 及 resolveType 的编程式分支（U4）。
2. descriptions.ts 逐字原文五段（U3；源文档路径在 §0 已锚）。
3. `seed as never` / `args as {…}` 窄化 / `session as never`（toolbox.ts:55，接缝 4 触碰处一并修类型）。
4. plugin.ts 单文件四合一结构（拆分后旧形状不复存在）。
5. 旧 `name` 参数语义（「纯展示、永非地址」）——终态 name 是寻址主键之一，旧注释/文案/断言同步删。

## 11. 测试计划

### 11.1 旧用例迁移矩阵（delegation.test.ts 21 用例 + notify-path 8 用例）

| 旧用例组 | 处置 |
| --- | --- |
| X1/X13 spawn 唯一 id、同名共存 | 改写（name=寻址键；latest-wins 断言；agentId 8hex 形态断言） |
| X17 未知类型带清单 | 改写（清单来源 = .md 装置种文件） |
| 类型生效（model/systemPrompt/tools 投影） | 改写（types 配置装置 → .md 临时目录装置） |
| X7/X8/X20 门禁组 | 改写（入参名 + **错误词表全换**——旧断言大面积改写，工作量按改写计非移植） |
| 通知组（唤醒双断言/步边界/error/blocked/aborted 不回潮/孤儿收养/teardown 抑制） | 移植 + 缺档占位通知 + 唤醒重验父存活新断言 |
| 动词组（message 忙闲/output cap/stop 幂等复活/list 子树/属主） | 改写（owner 边界仅 output/stop；message 开放寻址 + main/兄弟） |
| 白名单双断言 X15 | 移植（+ 复活后白名单不变断言） |
| fork 净化 X14 | 移植（+ model 参数忽略断言） |

### 11.2 新用例清单（每组带回归锚命名）

寻址：main 通道（子→父注入/根调用拒/父 dispose 后 not-found）；裸名 latest-wins；ambiguous
带 [ref] 清单；`name [ref]` 精确（含 output/stop 开放性）；agentId 未命中直接 not-found（不
转 archive）；archive 惰性复活（header 三字段断言/复活后 systemPrompt+tools 白名单不变/
类型定义缺失 fail-closed/worktree 复活重放 override）；跨进程（双真进程共享测试沙箱 root：
对端收信封 steer 进 main、busy 步边界、not-live、rename 抢占单读者、.proc 残留清扫、
at-most-once 语义、steer 异常不击穿 drain）；mailbox 协议（tmp+rename 原子——半写不可见、
box EEXIST 认领/活 pid throw、关箱删目录、墓碑两步回收不删活箱、manifest 坏退 pid 判活、
status 边沿即时重写）；notify_when_idle（订阅时已 idle 立即投、写后复查闭窗、一次性 fire、
纯订阅 message 省略、from 死仍删、teardown 结算、陈尸回收 idle-expired、子代理/进程内
目标/无 box 三种拒）；类型加载（frontmatter 垃圾降级、保留名拒、目录优先级、kick 边沿
重载+prompt 刷新断言、untyped/fork/空正文子见清单的机制事实断言）；worktree（真 git 仓
fixture：路径在 repo 外、子写落 worktree、主仓 read/write/grep 不可达、bash 命令体写主仓
被 fence 拒【fence 在场】、无改动清理、有改动保留+路径文案、git 失败 spawn 拒无残留、启动
期清扫崩溃泄漏、并发 spawn 串行、extraRoot 批原根子树被守卫拒）；task_output（agent 源）block/timeout
（完成即回/超时回 running 快照/block=false 立即——经 task-tools 工具面调用，路由/词表/bash 源用例在 task-tools 包内）；驻留档化（超 maxResident 最旧 dispose、
可按名复活）；**描述-schema 双向对账**（正向：schema 每字段名以词边界正则出现在
description；反向：description 引用的参数名 ⊆ schema 字段——锚=正则规则写死在用例里）；
mailboxTiming 注入（fake now/短间隔驱动 liveness/回收/心跳用例，无真 sleep）。

### 11.3 e2e 旅程（默认门新增三条，复用隔离装置惯例）

1. 跨进程旅程：真子进程（bun 起 harness 装配；detached + 超时 kill 兜底清理，失败不留孤儿
   进程）与主进程**共享测试沙箱 mailbox root**（与开发机默认 root 隔离）→ 开 box →
   list_agents 见 local-session 行 → SendMessage 往返（对端回复信封到主进程 main 消费）→
   notify_when_idle 恰好一条 notice → 双进程退出、box 目录清理、无陈尸。
2. worktree 旅程：临时真 git 仓装配（含 sandbox fence）→ spawn(isolation=worktree) → 子经
   假适配器调 write 落 worktree → 断言主仓 `status --porcelain` 空 + 主仓路径 read 拒 →
   task_stop 无改动自动清理（worktree 目录与分支消失）。
3. 复活旅程：spawn 子 → 子完成 → 主进程 teardown → 新装配 resume 主会话 → 按
   agentId message → 子从档案复活续轮（systemPrompt/白名单不变断言）→ 双会话 jsonl 落盘断言。

### 11.4 门禁与覆盖率

四门全绿 + 覆盖率行/语句/函数 ≥90、分支 ≥85 只升不降；新增两包数字如实分项报告。

## 12. 实施顺序（分阶段提交，每阶段四门+该阶段用例绿）

A. session-mailbox 新包（纯文件协议 + 单测 + timing/now 注入位；无消费者——单测即覆盖面）。
B. agent-delegation 重构地基：文件拆分 + lineage 双索引/8hex + 参数面/描述改写 +
   types-loader + system-prompt 注入；**接缝 1/1b（header 透传 + listHeaders）落地**。
C. 寻址终态：nameaddr + main 通道 + owner 边界重划 + agent_output block/timeout（件14 修订C：该两动词迁 task-tools）。
D. 跨进程接线：mailbox-consumer（一 box 一 drain/poller/manifest/认领关箱）+ list_agents
   扩展 + notify_when_idle（含闭窗与 expired 结算）。
E. worktree：接缝 3/4/6（grants override + PathGate 全链 + fence override）+ worktree.ts +
   清理 + 启动期清扫 + git 串行。
F. archive 惰性复活 + 驻留档化 + e2e 三旅程 + 全量四门。
（每阶段独立可回滚；F 后代码级两路对抗审查，本方案审查之外另起。）

## 13. 不处理（落档）与归属

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 云端会话 / Remote Control / agent-team（teammate、name@team） | 无云基建与账号体系；U1 边界外 | 未来云接入件 |
| 统一后台任务体系（bash run_in_background、task_id 注册表、输出文件指针、/tasks CLI） | U2 裁决不并入 | 后续任务体系件 |
| TaskOutput 输出文件路径模式（Read 输出文件） | 依赖任务体系 | 同上 |
| agent_output 的 DEPRECATED 定位 / TaskStop shell_id / ListAgents channel、q | U2/U3 派生：无任务体系则 output 为一等工具；弃用参数与占位参数不实现 | 本件内裁定 |
| reasoning effort / maxTurns / 预算；default subagent model 配置层 | AgentOptions 无字段；规格覆盖序的该层不存在 | agent-loop/llm 后续件 |
| 跨会话权限洗白机械执法；approval-hold 展示语义 | 需跨会话权限模型；规格亦为行为规范层执法 | permission 后续件 |
| busy=running 命名差异（本仓生命周期词表保留 running） | 本仓既有词表，改词破生态 | 本件内裁定，描述改写时说明 |
| manifest.status 只反映对端宿主 main 会话（子代理忙闲跨进程不可见） | box=会话级地址（规格同形） | 云接入件一并 |
| pid 复用 30s 宽限窗 / NTP 墙钟回拨 | 本机单用户信任域，风险接受 | 挂账 |
| 档案级锁（跨进程双开 resume 的机械拦截） | 依赖宿主部署纪律（box 唯一+会话归父进程） | 挂账 |
| 未装配 sandbox-local 时 bash 命令体不在隔离执法面 | fence 是内核层唯一执法点 | 部署纪律 + description 规范层 |
| ~~类型变更 kick 边沿粒度~~ | 已根治（types-loader 同步 fs + 快照 render 当轮拾取，docs/TAIL-SNAPSHOT-CHANNEL.md） | 本件内核销 |
| fork 复制剔除开放轮（末 turn/end 切口） | X14 工程裁决（在飞轮不可安全复制） | 本件内裁定 |
| 通知合并 digest / 信封闭合标签中和 | 沿旧落档（X3/X18） | 挂账 |
| message 300 上限的「文件中转」专建通道 | 复用现有 write/read | 不建 |
| mailbox 跨机/加密/鉴权 | 本机信任域（0700） | 云接入件一并 |

## 14. 对抗审查处置（两路并行，41 条全处置）

**路 A（契约/语义对照面）**：P0-1 worktree 与 fence 倒置/bash 穿透 → **采纳**：接缝 6
（fence 会话级 rootOverride）+ 路径迁 repo 外（§8.1）+ 双层执法与降级边界如实声明（§8.2）
+ bash 面测试补齐（§11.2/§11.3-2 含 fence 断言）。P1-1 message 必填矛盾 → **采纳**：统一
可选（§2.1）。P1-2 summary 传输 → **采纳**：信封删 summary、仅结果回显、超长截断（§2.1/§5.3）。
P1-3 回信直达子代理 → **采纳**：跨进程仅 box 域、from=父 box、回信进 main（§5.2/§5.3）。
P1-4 output/stop 消歧死锁 → **采纳**：复用 2/3/4a/4b、[ref] 开放（§4.4/§5.2）。P1-5 复活
断链 → **采纳**：header 落 name/type/depth 三字段、复活按类型重建 options、agentId 未命中
直接 not-found（§4.2/§5.2/§6.2）。P2-1 词表表述 → **采纳**：删「对齐规格」、落档命名差异。
P2-2 expired notice → **采纳**：陈尸回收结算 idle-expired；approval-hold 落档。P2-3 进程内
目标未定义 → **采纳**：仅 box 目标，三种拒（§4.4）。P2-4 §7.2 等价失真 → **采纳**：改机制
事实表述（§7.2）。P2-5 bash cwd → **采纳**：接缝 4 扩（§3/§8.2）。P2-6 box ref 未定义 →
**采纳**：bootId 尾 6 hex + agentId 8hex 化（§4.2/§5.2）。P2-7 落档断链 → **采纳**：§13 补
shell_id/channel-q/DEPRECATED 三行。P3-1/2/3/4/5/6/12 → **采纳**：扩展参数标注、default
model 落档、untyped 如实、aborted 入词表、to 单行、live 定义、fork 剔开放轮落档+§2.3 补
两条行为规范。P3-7 mtime 挂点 → **采纳**：降级 kick 边沿（§7.1）+落档。P3-8 list 接口 →
**采纳**：接缝 1b listHeaders（§3）。P3-9 标签统一 `[Cross-session idle notice]`（§2.3/§5.4）。
P3-10/11 计数与对账 → **采纳**：§9.1 改 5 处、§11.2 双向对账。

**路 B（并发/资源生命周期/架构/假绿面）**：P0-1 原子性三则 → **采纳**（§5.3）。P0-2
notify_when_idle 闭窗 → **采纳**：双向闭窗+线性化点（§5.4）。P0-3 box EEXIST/关箱 →
**采纳**：认领/关箱删目录（§5.3）。P0-4 bash 假绿 → 与 A-P0-1 合并处置（§8.2/§11）。
P1-5 inject 清单 → **采纳**（§3/§9.2）。P1-6 复活丢 override → **采纳**：重放（§6.2）。
P1-7 寻址死路 → 与 A-P1-3 合并处置（§5.2/§5.3）。P1-8 一 box 一 drain → **采纳**：+路由
进 main+失败语义（§5.3）。P1-9 agentId 撞号 → 与 A-P1-5 合并（§4.2）+ 启动期清扫（§8.3）。
P1-10 定时器生命周期 → **采纳**：ctx.effect+dispose 序列+unref（§5.3）。P1-11 驻留无上限
→ **采纳**：maxResident 档化（§2.2/§4.1）。P1-12 崩溃泄漏 → **采纳**：启动期对账清扫
（§8.3）。P1-13 depth 回溯 → **采纳**：冗余落盘（§6.2）。P2-14 至 P2-24 → **全采纳**：
at-most-once 声明+drain 兜底（§5.3）、接缝 4 逐点（§3）、override×extraRoots 守卫（§3/§8.2）、
manifest 三则（§5.3）、墓碑两步（§5.3）、占有模型如实（§6.2）、接缝 1 通道写明（§3）、
kick 边沿（§7.1）、timing 注入（§2.2/§11.2）、对账锚反向+词边界正则（§11.2）、e2e 孤儿
清理+沙箱 root 表述（§11.3）。P3-25 至 P3-33 → **全采纳**：瞬态注明（§4.1）、词表拆句
（§2.1）、墙钟/unref（§5.3/§13）、唤醒重验（§4.1/§5.1）、slug 回退随机段（§6.1）、两步
非原子注明（§5.4）、manifest.status 粒度落档（§13）、git 串行（§8.1）、迁移矩阵工作量
如实（§11.1）。


> 注：本节及以下历史处置节中的 agent_output/agent_stop 提法，其工具已于件14 修订C 迁 task-tools（§17）。
## 15. 代码级对抗审查处置（F 收口前两路并行，2026-09-19）

> 状态：件13 六阶段实施完成；两路代码审（A 契约/假绿面 21 项、B 并发/生命周期 15 项）全处置。

**路 A（契约/语义/假绿面）**：P0-1 对账用例缺席+描述违约 → **采纳**：contract.test.ts 双向
对账三用例（词边界正则）落地即绿前先补齐描述真实能力（message 补 summary/notify_when_idle/
box 寻址/纯订阅/复活语义；list 补 local-session 行与 [ref]；output 超时摘要措辞）。P1-2
启动清扫互删 → **采纳**：FRESH_MS=1h 新鲜度门槛（崩溃泄漏必超窗）+ 测试装置默认关。P1-3
复活丢 worktree 隔离 → **采纳**：接缝 1 再扩 header.agentWorktree；复活重放 setRootOverride
（树已清/授权面缺席 → onWarn 明示降级）。P1-4 组合零测试 → **采纳**：worktree.test 补
「子会话视角」组合用例（gate×grants×spawn 子会话键：worktree 放行/主仓拒/守卫过滤/父
不受影响）。P2-5 sweep 分支错 → 与 B-P1-4 合并处置（`entry.slice(indexOf("agent-"))` +
清扫用例补分支断言）。P2-6 歧义词表 → **采纳**：ReviveOutcome 三态，ambiguous 带指引
文案；测试锚同步。P2-7 notify 进程内目标拒 → **采纳**（§4.4 三种拒补全）。P2-8 超时快照
补末轮摘要 → **采纳**。P2-9 to 单行 pattern → **采纳**。P2-10 summary 截断不拒+回显 →
**采纳**（schema 去 maxLength、200 截断、结果回显）。P2-12 inject/permission → **落档**：
permission 可缺席是合法部署（纯进程内），走 tryUse；顺序脆弱性由装配纪律承担（文档 §3
勘误：inject 不含 permission、mailbox 同理）。P2-13 复活白名单不收窄 → **采纳**：
parentToolsOf 读 registry.restrictionOf 注入 narrowTools（X15 不因复活放宽；W2A 后唯一真相在会话层）。P3-14 stopped 绕驻留上限 → **采纳**
（stopped 计入驻留；档化后 message 走 archive 复活，停止可续语义不变）。P3-15 abort 漏
worktree 清理 → **采纳**（+ 建树前前置 abort 检查）。P3-16 prompt 空白串 → **采纳**。
P3-17 e2e 弱断言 → **采纳**（notice 恰好一条计数、复活 whenIdle 屏障；cross.test 真
sleep 存量 1 处——timing 注入改造挂账 F 后续）。P3-18 list 行/描述偏差 → **采纳**。
P3-19 死导出/devDeps → **采纳**（index 收缩至 plugin+类型；persistence-jsonl 移
devDependencies）。P3-20 TOCTOU 小窗 → **落档**（评估窗 ms 级，sweep 新鲜度门槛兜底）。
P3-21 real.ts 残留 → **归属**：他人在途未提交改动，不越界。

**路 B（并发/生命周期）**：P1-1 teardown 序倒置+shutdown 未 await → **采纳**：drain/心跳
effect 后置注册（逆序回卷即「停 drain → 停心跳」）、composite 内 await shutdown（§5.3 序
成立）。P1-2 settle 双结算 → **采纳**：consumer 单飞 promise（idle 边沿与 teardown 并发
复用在飞）。P1-3 manifest tmp 同名 → **采纳**：tmp 唯一后缀 + manifest 缺席不无条件判陈尸
（statStale 目录 mtime 超龄才回收）。P1-4 sweep 分支错 → 见 A-P2-5。P2-5 abort 窗口 → 见
A-P3-15。P2-6 sweep 互删 → 见 A-P1-2（新鲜度+本进程 live 排除留待跨进程协调件）。P2-7
认领非原子 → **采纳**：claim 文件 wx 独占裁决。P2-8 复活丢隔离 → 见 A-P1-3。P2-9 复活
旅程假屏障 → **采纳**（whenIdle 完成屏障）。P3-10 apply 失败定时器泄漏 → **采纳**（effect
注册推迟到 apply 尾）。P3-11 PathGate(override) 热路径 realpathSync → **落档**（每次一
次已存在路径的 realpathSync，量级可接受；缓存挂账）。P3-12 `as never` 类型逃逸 → **落档**
（随 toolbox 后续件统一 SessionId 导入）。P3-13 清理失败零上报 → **采纳**（onWarn 出口：
sweep kept/关箱尽力路径）。P3-14 drain 重入乱序 → **采纳**（自链式调度）。P3-15 real.ts →
**归属**同 A-P3-21。


> 注：同上——output/stop 处置记述针对当时的 agent_output/agent_stop，现状见 §17。
## 16. 修订A/B（2026-09-19 用户裁决，同日实施）

**修订A「去名」**：agent_spawn 删除 name 入参与名字概念——**agentId 是子代理唯一身份**
（`agent-<8hex>` 随机；header.agentId 落盘跨重启稳定；复活沿用不重铸）。连锁删除：名索引/
slug 铸名/裸名 latest-wins/`name [ref]` 消歧/档案同名 ambiguous 词表（歧义面整体消亡）。
寻址收敛：`to` = agentId 精确 | main | box 名；task_id = agentId 精确。SessionHeader 锚
agentName→agentId（store/gateHeader/复活扫描同步）。evictIdle 增 archive 守卫：纯内存部署
（无 jsonl）跳过档化——无盘不踢，「可再 message」不静默毁约（审查遗留处置）。

**修订B「逐字对齐」**：五工具 description 与参数描述回到规格源文档逐字口径（重同步纪律，
contract.test 以 spec blockquote 逐字符比对为机械锚）；参数面与规格参数表一致：message
改为必填（pattern `^[\s\S]{0,300}$`；纯订阅经 description 的运行时语义，schema 层由
必填封锁——spec 自身的 required/描述矛盾按 required 执行）；isolation 枚举
worktree|remote（remote 运行期门控拒，spec「availability is gated」）；block/timeout/
task_id/to/summary 的描述与上下限逐字对齐。

受影响节：§2.1（参数表/行格式/词表）、§4.2-4.3（无 name 字段）、§5.2（六步算法收敛为
三分支）、§6（6.1 名字注册整节废止；6.2 按 agentId 复活）、§9.2 裁决表、§11.1 迁移矩阵
（X13 同名共存用例改 agentId 互异并存）。

## 17. 修订C（2026-09-19 件14：读停动词迁出）

`agent_output`/`agent_stop` 从本包工具面删除——**模型侧动词统一为 `task_output`/
`task_stop`**，由新包 @x-harness/task-tools 提供（TaskHub 三态路由：hit/denied/miss，
kind 字典序 agent 先于 bash）。本包改为：plugin inject 增 `"task-tools"`（硬依赖），
`agentTaskSource(verbDeps)` 注册 agent 源（probe = nameaddr 解析 + owner 预检；verbs 的
output/stop 签名提参 `caller: SessionId | undefined`，经路由层调用）。bash 源在 task-tools
本体内经工厂参数 `bashTasks: BackgroundTasks` 接线（toolbox 零改动——用户三次裁决）。
通知尾注与 reportCap 注释的 agent_output 提法同步改 task_output。方案与处置全记录：
docs/TASKS.md（件14）。
