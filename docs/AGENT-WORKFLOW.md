# AGENT-WORKFLOW：验收回炉与任务编排终态（件 16）

> 状态：**方案定稿 v3.2**（方案三轮审查 + 实现终审三路 + 期 2 两路对抗审查全处置——§15 留档。
> v3.1：终审对账（包名/F14/恢复表三行/锁域/Tier B 契约/taskId 前缀/settlement 兜底）。
> v3.2 增量：期 2 四功能（会话重绑 run/rebound/Tier C critic 自举/depends_on·悬空拒/
> GC·冷停止·标记收窄）+ 两路处置（critic 预算 reopens 联动/critic 与恢复的活 caller/
> GC 三防线/幂等迁移判据/critic 异常终态不回炉/未认领 run 迁移）。
> 级别：高（workflow-core 新包（纯引擎）+ agent-workflow 新包（插件）+ agent-delegation
> 三接缝 + task-tools 源让位 + CLI/hub 两宿主装配）
> 上游关联：件13 AGENT-DELEGATION §1 U1 落档的是 **teammate/name@team 常驻团队寻址（云形态）**。
> 本件提供 **run 级多任务协作**（工作单元的受控流转：验收/回炉/DAG）——无成员身份、无团队
> 拓扑、无中心 Engine，与 U1 落档对象正交；未来若重启 teammate 裁决，本件的 Acceptor/journal
> 是可直接复用的地基而非竞争实现。
> 设计输入：ZCode 双实现批判性审计（§13）。首轮审查关键修正：受管子代理**生命周期所有权
> 归 workflow**（§6 三接缝之③——原「路由参数」表述被 A2/B-01 证伪）；恢复协议从一句话
> 升格为**二维窗口表 + 确定性幂等标记**（§5）。

## 0. 动机与终态定义

现状：子代理完成通知只透传 `turn/end` 词表——「模型说完了」≠「可交付」。MiniMax Agent Team
文章检验五问中「如何验收」在 x-harness 无答案：无 Verifier 角色、无验证不过回炉、父代理
收到 completed 即视为终态。

本件目标：给任务提交补**确定性验收回炉闭环**（producing→verifying→done 状态机的去中心化
形态）——每个任务自带验收器与回炉预算，由确定性代码驱动裁决，模型不参与「自己验收自己」。

**终态边界**：
- 做：结构验收（schema）/ 命令验收（沙箱执行）/ 评审验收（critic 子代理，期 2）三档可组合；
  per-run journal 事件溯源 + 崩溃恢复；受管通知路由（验收完才通知父）。
- 不做：静态 phase 流水线（是用法不是机制）；模型写 TS 脚本编排（ZCode dynamic-workflow
  路线——编译器与 facade 的复杂度不承担）；统一后台任务体系（件13 U2 维持）；跨会话记忆
  沉淀（§14 挂账）；云端/remote；teammate 常驻团队寻址（U1 维持）。

## 1. 用户裁决记录（2026-09-26 讨论定稿；v2 修订标注）

| # | 裁决点 | 决定 | 派生后果 |
| --- | --- | --- | --- |
| W1 | 实现位置 | **旁挂插件，不进 agent-delegation**——子代理实现保持纯粹 | 编排策略与通信/生命周期原语分离；delegation 只补 §6 **三接缝**（v2：原「两接缝」被审查证伪——受管行的生命周期豁免是第三个不可省的原语面） |
| W2 | 状态存储 | **per-run journal WAL（事件溯源）**，绝非内存态——生产可用底线：父会话死亡/进程崩溃后 run 可查可续 | 单一事实源纪律（§4，含证据尾料豁免边界）；目录解析遵循仓库模式（§3.2）；run 锁照 lock.ts 全套（§3.1） |
| W3 | 验收抽象 | **Acceptor 两层**：证据采集器（async，插件层）+ 裁决器（纯函数，core）（v2：原单接口「纯函数」装不下 Tier B/C 的 IO） | 三档是裁决器组合；扩展点即接口 |
| W4 | 回炉通道 | **统一 steer 步边界注入**，不注入工具进子会话 | 反馈铸文首行带确定性幂等标记（§8.3，v2 补）；in-turn 时机为期 2 参数 |
| W5 | 交付协议 | **typed 校验，非 typed 通道**（v2 诚实化：W4 下无 submit 工具，载荷从终态文本抽取、抽取靠 prompt 增补约定、**校验**是 typed 的兜底） | Tier A 首轮即带结构化交付指令（§8.2），不白烧 repair 预算；critic 提案同款（期 2） |
| W6 | 无验收器提交 | **直通 = 零 journal 足迹**：不建 run 目录、不落任何事件、不设 settlement（v2：否则 journal 僵尸或契约撒谎） | 返回 `{taskId: agentId, runId: agentId}`（描述声明直通形态）；通知物理走 delegation 原路径，字节级等价 agent_spawn |
| W7 | 工具命名 | **workflow_submit**——task_* 前缀已被 task_stop 与 todo 族占据 | 动词四族分立：agent 族/workflow 族/task 族/todo 族；journal 事件词表 task/* 为内部词汇不改 |
| W8 | 受管生命周期 | **run 终态前，受管子代理的处置权归 workflow**（v2 新增）：delegation 的孤儿收养/档化/级联清理对 managed 行全部豁免；dispose/清树由 workflow settle 驱动 | delegation 不变量④的显式修改（§6 接缝③），带独立单测锚 |

## 2. 架构与包边界

```
packages/workflow-core/          纯引擎（零 IO：不依赖 agent-loop/session/delegation——实现包名；v3 文档曾写 agent-workflow-core）
  types.ts        事件/状态/裁决闭合词表（裁决器接口在此）
  fold.ts         事件折叠 reducer（events → snapshot；纯函数）
  verdict.ts      裁决器：证据 → Verdict、预算扣减、组合器（纯函数）
  readiness.ts    就绪推导（depends_on 拓扑 + 并发上限 + 熔断 + 依赖失败传播；纯函数）
  __test__/       穷举单测（测试即规格）

packages/agent-workflow/          插件包（IO + 接线；一动词一文件）
  plugin.ts         装配（inject: tools/agent-loop/task-tools/session；
                     softInject: agent-delegation/sandbox/exec-env/session-persistence-jsonl）
                     （v2：inject 补 session、softInject 补 archive——恢复读子会话 WAL 必需）
  journal.ts        WAL 写面 + run 锁（lock 文件 pid+bootId+死锁接管，照 lock.ts 全套）
  resolve.ts        目录解析（resolveWorkflowRoot 三段链，§3.2）
  resume.ts         启动期重放：扫描（作用域过滤）→ fold → 二维窗口表补动作（§5）
  tools.ts          workflow_submit 工具面（schema/描述，含直通声明）
  delegation.ts     三接缝消费：spawn(settlement)/revive/受管路由接线
  acceptor-schema.ts    Tier A 采集器（抽取 + 校验）+ 裁决器接线
  acceptor-command.ts   Tier B 采集器（intent 事件 → 沙箱执行 → result 事件）
  acceptor-critic.ts    Tier C 采集器（期 2）
  feedback.ts       回炉反馈铸文（幂等标记 + violations + schema 提示）
  notify.ts         完成通知投递（活父注入/死父悬置 + sessionCreated 边沿补投）
```

依赖方向：`agent-workflow → { workflow-core, agent-delegation(softInject), task-tools, sandbox, session }`；
两宿主经 `workflowKit({ root, mainSession, budgets? })`（harness 包）装配——不装即无此面，
行为与现状全等。`mainSession` 必收（B2-06：§5.1 过滤条件②的判值来源——CLI 先铸 id /
hub thread 会话 id，mailbox mainSession 先例同构）。

**workflow 插件 dispose 序列（F3——v2 零字，v3 钉死）**：停 Tier B 在飞沙箱进程（abort）→
journal 屏障 fsync 收尾 → run 锁不显式释放（死锁由 pid 活性接管——显式释放反而引入退出
竞态）→ 受管行**不** cancel（豁免兑现，§5.4）。装配/回卷序事实：softInject 拓扑 delegation
先 apply → 回卷 LIFO 时 workflow 先回卷、delegation 后回卷——workflow dispose 时接缝仍
可用（兜底回收路径可达）。

## 3. 存储与目录

### 3.1 per-run journal（事件溯源）+ run 锁

```
<workflowRoot>/<runId>/
├── header.json     # { runId, parentSession, cwd, createdAt, pluginVersion }
├── lock            # pid + bootId（活锁拒绝、死锁 rename 原子接管——lock.ts 同款全套）
└── journal.jsonl   # append-only 事件流（词表 §7；闭合 fail-closed）
```

- `snapshot = fold(journal.events)`——journal 只落**编排事实**（豁免边界见 §4）
- 写面工程语言与 session-persistence-jsonl 同款：per-run 串行链、实时段 append + 屏障
  fsync、失败截断回滚保前缀序、撕裂截断到最后换行
- **run 占有 = lock 持有**（v2：原「header 活」无判据）。**锁形态照实 pid-only**（F12/
  B2-04 修正：lock.ts 实际只有 `${pid}`，无 bootId 无接管窗——v2 的「pid+bootId 同款全套」
  与照抄对象不符）：活锁拒绝、死锁 rename 原子接管（wx 重建权威，两进程同刻接管恰一胜者，
  败者拒绝）；pid 复用误判存活 = 拒接管（安全侧，30s 窗落档——与 session 锁同边界）
- **恢复矩阵**（v2 补；v3 补中段损坏行——B2-05）：目录被外部删除 → 等价 run 不存在（子
  会话 WAL 仍在，可手动 revive，onWarn）；header 半写/损坏 → run 冻结 + onWarn（不自动
  重建）；journal **尾部**撕裂 → 截断到最后完整行 fold（前缀语义）+ onWarn；journal
  **中段**行损坏（完整行但不可解析）→ **run 冻结 + onWarn**（对称 header 损坏——截尾
  救不了中段，fold 拒绝半途状态，不临场发明跳过语义）

### 3.2 目录解析（仓库既有模式——插件零目录知识）

```ts
resolveWorkflowRoot(custom?: string): string
  = custom ?? env.X_HARNESS_WORKFLOW_DIR ?? join(harnessHome(env), "workflows")
```

（v2：三段链，harnessHome 已含 X_HARNESS_HOME > ~/.x-harness 兜底——原四段伪代码第三支
恒返回致第四支不可达。）插件工厂 `root` 必收；CLI 走 `--workflow-dir`（同 `--session-dir`
形态）；hub 走 fields.env 注入（mailboxRootOfWorker 同款）；测试装置显式 temp（mailboxRoot
隔离同款纪律）。

## 4. 单一事实源纪律（含 v2 豁免边界）

| 账本 | 所有者 | 记什么 | 绝不记 |
| --- | --- | --- | --- |
| workflow journal | agent-workflow | 编排事实：派发/验收裁决/回炉/结算/通知投递/verify intent-result 对 | 对话内容 |
| 子会话 WAL | session-persistence-jsonl | 对话事实：消息/工具调用/steer 注入/turn | 编排状态、验收预算 |

锚点 = `header.agentId`（落 `task/dispatched`，跨进程稳定）。

**豁免边界（v2，堵 A6 自相矛盾）**：`task/settled.evidence` 允许携带 **reportCap 截断的证据
尾料**（violations 列表 / 命令输出尾 / verdict 摘要）——这是裁决的**依据**，属编排事实；
critic 完整报告**不落 journal**，只落子会话指针（报告本体在 critic 子会话 WAL 里，按需
agent_message 追问）。`pluginVersion` 消费规则（v2 补，堵 A5-2）：重放时版本不符 → onWarn +
**只读不补动作**（fold 出 snapshot 供查询，不执行恢复动作）——spec 原样落盘意味着裁决可随
实现演进，此为已接受取舍（§15 A5 处置），不借 SESSION-RESUME 的闭合词表承诺背书。

## 5. 崩溃恢复（v2 重写：二维窗口表 + 作用域 + 触发边沿）

### 5.1 启动扫描（作用域过滤，堵 A8/B-07）

plugin.apply 时：扫描 workflowRoot（先读 header 剪枝——parentSession/run 终态，避免全量
fold 的启动成本无界增长，F15）→ 对每个 run 先 fold 记账 → **只对满足全部三条的 run 执行
恢复动作**：
1. lock 可接管（无锁/死锁）——活锁 run 属他进程驱动，跳过不报错
2. `header.parentSession ∈ 本进程会话管辖集`（= workflowKit 装配时传入的 mainSession
   [CLI 先铸 id / hub thread 会话 id——mailbox mainSession 先例同构，B2-06]；运行期扩展为
   本进程 live 会话集，覆盖子代理提交的 run）——他父的 run 跳过
3. `header.pluginVersion` 与本插件兼容（不符 → 只读不补动作，§4）

跳过即跳过：不失败装配、不改状态——多进程共享 root 安全。

**期 1 工具面限定根会话**（F13 派生）：workflow_submit 仅根会话可用（对齐 notify_when_idle
仅根会话先例，AGENT-DELEGATION §4.4）——子代理调用 → invalid-args 拒。子代理提交 run 的
恢复管辖（live 会话集扩展）期 2 开。

### 5.2 二维窗口表（journal 末事件 × 子会话 WAL 终态，堵 B-02/B-03）

**子会话 WAL 终态判定算法**（F8——扫描器职责，不依赖 loop.resume 副作用）：fold(archive)
后，若存在开放 `turn/start`（无配对 `turn/end`）→ **合成 interrupted**（与
interruptedTurnClosers 同构）。终态四分类：completed（末 turn/end{completed}）/ interrupted
（合成）/ 未起跑（无 user 消息）/ **异常终态**（末 turn/end{error|blocked|max-tokens}）。

| journal 末事件 | 子会话 WAL 终态 | 恢复动作 |
| --- | --- | --- |
| `run/created` | （无任务） | 静默续 |
| `task/submitted` | 无 dispatched 后续 | 重派发（spec 在 journal）；「该父名下不被任何 run journal 引用的子会话/worktree」经 delegation 启动清扫语义回收（B-03/F 复审措辞修正——journal 无 dispatched 即不可知 agentId） |
| `task/dispatched` | completed | **直接进验收**（不唤醒不重跑） |
| `task/dispatched` | interrupted | `view.revive(agentId, settlement)` 重建**受管**行 + **kick 文本**（loop.resume 不自动 kick，A1）："continue task <taskId>；上下文已恢复" |
| `task/dispatched` | 未起跑 | revive + 收件箱已有回灌 prompt（claimReinserts）则仅 kick；收件箱空则重放 prompt'（F7 反向：不双份排队） |
| `task/dispatched` | **异常终态**（error/blocked/max-tokens） | `task/settled{failed, cause: child-failed}`（detail 透传 failureDetail 同源词表）——**不进验收不烧预算**（F6c：error 终态常无 assistant 文本，抽取必 reject） |
| `task/repair-issued` | completed（修复轮已干完） | **直接进验收**（F6a：表 v2 折叠「等修复」会悬死） |
| `task/repair-issued` | interrupted/未起跑 | revive + 按幂等标记判（见下）已材料化 → kick 续修；未材料化 → 补注入 |
| `task/repair-issued` | 异常终态 | 同 dispatched 行：settled{failed, child-failed} |
| `verify/started`（Tier B） | — | 无 `verify/result` 配对 → 落 `verify/result{outcome:unknown}`，任务按 fail 处置（B-10 不盲目重跑——副作用可能已发生）；有 result → 正常裁决 |
| `verify/started`（verifying 态） | — | `closeDanglingVerify` 落 `verify/result{unknown}` + `settled{failed, verify-unknown}`——**不重跑命令**（B-10；终审 D2 接线：stopTask 取消路径同款同步封口） |
| `task/submitted`（无锚） | — | **重派发**（spec 在 journal：dispatchPrompt 重铸 + spawnManaged + settlement 挂接——runtime.redispatch）；死父悬置等边沿（终审 A3） |
| `task/settled` | — | 无 `notify/delivered` → 补投（§5.3）；已投 → 静默。**跨重启**：settled 且未投的 run 被扫描认领补投后收尾关卷（终审 B5——悬置通知的唯一跨重启收敛路径） |
| `run/settled` | — | 静默归档（run 后迟到 task/verify 事件收编，§7） |

**幂等判据（F7 修正）**：标记出现在**已材料化消息**（user/message 或 agent/message 事件体）
中才算「已送达」——inbox insert 事件（agent/inbox/spliced）只证明入队不证明消费（子崩溃于
消费前则模型从未见过）。kick/反馈/通知全按此判。

### 5.3 补投触发边沿（堵 B-08）

两宿主装配序都是插件 apply 先于主会话建立——apply 时刻的「死父」无法补投。规则：
- **apply 时**：只 fold 记账 + 对「不需要父」的动作（revive 续跑、验收执行）立即执行
- **主会话建立/复活边沿**：sessionCreated 事件（create/resume 两形态同源——resume 也走
  store.create）。**时序陷阱（F14，终审修正）**：该事件在 store.birth 内同步发射，此刻 loop 句柄
  尚未登记（create 的 await 链后段才 live.set）——微任务延迟对「重建补投」不够（终审实测
  句柄仍缺位），监听器内必须**轮询等待句柄在场**（2ms × ≤50 拍，runtime.onSessionAlive
  入口）。补投插入序：next-step 注入天然排在已排队 followup（next-turn）之后——宿主边沿
  处理先于向用户提示输入达成「先于用户首条消息处理」的等价效果；断言锚进 §11。

### 5.4 运行期父会话死亡（W8 的兑现）

**「存活」的精确语义（F2 修正——v2 表述与机制事实相反）**：受管行豁免的是 *delegation
的处置*（收养/档化/级联），**不是**「进程退出后子代理继续跑」——进程退出（CLI 退出、hub
worker 优雅停机或被杀）时 session disposer 封存全部会话，受管子随进程消亡，在飞 LLM 请求
中断，子 WAL 留开放轮。两停机形态（优雅/SIGKILL）恢复路径**完全相同**（§5.2 interrupted
行 → revive+kick），差异仅尾段 flush 干净度。「继续跑完 → 验收 → 通知悬置」仅适用于
**父会话 dispose 而进程活着**的窗口（REPL /new、hub client-abort）——该窗口内子代理
确实继续（delegation 不处置它），完成后验收照常，通知悬置落 journal 等父 resume 边沿
补投。hub 停机对受管行的正确期待：豁免 stopAll 的 cancel（不落 emitFinished 的 stopped
终态），journal 停在当前事件——下次认领按 §5.2 恢复。

## 6. delegation 接缝（v3：四个，均为原语非策略）

1. **`delegationView.spawn(caller, input & { settlement?: SettlementToken })`**
   服务面补全（caller 首参与既有四动词同构——R7）。`settlement` 是**不透明 token**（v2：
   弃 SessionId——workflow 无会话身份，SessionId 会与「直达父」路由同键，B-04）：在场的
   子代理行挂受管标记，完成通知改投 token 寻址的结算入口。Tier C critic 的 spawn 同走此面
   （caller = 提交会话——critic 的 parent/占槽/depth 归提交会话记账，其完成投 critic 结算
   token，不经 to:main 绕道，R7）。**服务面无 execCtx**——内部合成 AbortSignal
   （B2-可实施性补充）。跨服务传函数面先例：permissionBroker.ask。
2. **`delegationView.revive(caller, agentId, settlement?)`**
   既有 reviveByAgentId 的服务面出口（v2 新增；**v3 补 settlement 透传**——B2-01：不带它
   则恢复行是普通行，通知绕过验收、父缺席被收养处死——首轮 A2/B-01 的洞在恢复路径复发）。
   重建行时 settlement 在场即重建为**受管行**。类型 .md 缺失 → fail-closed 拒（任务落
   `settled{failed, type-def-missing}`）。deps 侧复用既有 reviveDepsOf 闭包，不泄漏内部结构。
3. **`delegationView.settle(agentId, cause)`**
   v3 新增（B2-02：settle 归还无面可调——stopAll 误杀同父直通子、verbs.stop 未上 view、
   lineage 摘行/worktree 清理是 delegation 私有面）。内部走 verbs.stop 同款序列（cancel →
   whenIdle → dispose → evaluateCleanup → 摘行），供 workflow 对**单个**受管行做终局归还。
4. **受管行生命周期豁免（W8；v3 补第五条 settle 失败防线）**
   delegation 五处对 managed 行的行为修改（不变量④显式修订，独立单测锚）：
   - 孤儿收养（adoptOrphan / deliverToRow 父存活预检）：跳过——受管子不因父缺席被处死
   - evictIdle 档化：跳过——repair 等待窗内不被踢（R9）
   - stopAll / 插件 dispose 级联：跳过 cancel/dispose/清树（B-01；「存活」语义见 §5.4）
   - 完成通知：投 settlement token 而非直达父
   - **settlement 投递/落账失败兜底（F1，终审 D5 实现形态）**：sink 构造收第三参
     `onSettleFailed(agentId, error)`——异步转发失败无法同步冒泡回 delegation，改为显式
     兜底回调（`view.settle(agentId, "settle-failed")` 归还受管行 + onWarn；journal 侧由
     下次恢复边沿按窗口表收敛为 settle-failed）。
   - **settlement 投递/落账失败兜底（F1）**：token 投递 throw 或 workflow 侧 journal append
     失败 → delegation 兜底回收（dispose 子 + 清树 + 摘行 + onWarn；任务由 workflow 恢复
     边沿落 `settled{failed, cause: settle-failed}`）——豁免不是无条件永久豁免，是
     「settle 可达时豁免、settle 失联回收」。workflow 插件永不以外部插件（plugin-manager）
     形态分发——kit 装配同 world 同死，token 失联只剩 journal 失败/回调 throw 两径，均被
     此条兜住（F4 前提锁定）。
   子代理的最终 dispose/清树/摘行 = 接缝③ settle 或第五条兜底，二者必经其一。

接缝实现落 agent-delegation 包内（view.ts/plugin.ts/notify.ts/lineage.ts/verbs.ts/
task-source.ts 六文件；task-source 的 probe 对 managed 行 miss 是 §9 让位协议的实施位，
与豁免清单合并点名防漏——B2 复审意见）。每处带独立单测（受管分支 + 普通路径不回归
双向断言）。agent-workflow softInject 消费（解析动词：softInject 保证 topo 先装 → apply
期 tryUse 即得，budget-guard softInject agent-loop 先例——B2-07 写明）：delegation 缺席 →
受管 workflow_submit 拒 invalid-args（运行期 fail-closed）；**恢复期**发现 in-flight run
而 delegation/archive 缺席 → run 冻结 + onWarn，不失败装配（R2）。

## 7. 事件词表（闭合 fail-closed；v2 补 dispatch 失败/verify 对/tier 字段）

```
run/created {runId, parentSession, cwd}
run/settled {outcome: completed|failed|cancelled, detail}
task/submitted {taskId, spec}
task/settled {taskId, outcome: completed|failed|cancelled, verdict, detail, evidence?, cause?}
   # outcome=failed & cause=dispatch-failed：spawn 被拒（busy/max-depth）落账——堵 A5-1 状态死角
   # outcome=cancelled & cause=dependency-failed|circuit-break：级联取消——堵 A4 死锁
task/dispatched {taskId, agentId, sessionId}
task/repair-issued {taskId, tier, attempt, violations?|output?}   # v2 补 tier（T2）
verify/started {taskId, tier, attempt}      # v2 新增：Tier B intent 事件（副作用双跑防线）
verify/result {taskId, tier, attempt, outcome: passed|failed|unknown, exitCode?}
task/reopened {taskId, attempt}             # Tier C（期 2）
notify/delivered {taskId, to}
```

迟到事件收编规则（v2 堵 A4-3；v3 扩到 task 终态后 verify——F5）：**task 终态后同任务的
verify/*、run 终态后的 task/* 一律收编为后事件**，不拒不弃（词表 fail-closed 指类型未知，
非时序未知）——覆盖：task_stop 让位时恰有 Tier B 命令在沙箱跑、熔断级联时在飞 verify。
cancel/级联路径同步落 `verify/result{outcome:unknown}` 封口（尽力——迟到真实 result 照样
收编）。cause 词表补：`dispatch-failed | dependency-failed | circuit-break |
child-failed | settle-failed | type-def-missing | verify-unknown`。

## 8. 验收器：两层接口 + 三档（v2 修 R3 接口形状）

### 8.1 两层（W3）

```ts
// 采集器（插件层，async——证据在 IO/子进程里）
interface EvidenceCollector {
  collect(task: TaskSnapshot, child: SessionFacts): Promise<Evidence>;
}
// 裁决器（core 纯函数——可穷举测试）
type Verdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }   // 回炉（feedback 由 §8.3 铸文层生成）
  | { kind: "fail"; reason: string };             // 预算耗尽终局
function adjudicate(tier: TierSpec, evidence: Evidence, budget: BudgetState): Verdict;
```

### 8.2 三档

| 档 | 触发参数 | 采集 | 裁决（纯） | 预算（装配参数） |
| --- | --- | --- | --- | --- |
| **A 结构** | `result_schema` | 终态 assistant 文本抽 JSON（依赖 prompt 增补约定，W5 诚实版）+ 字符串载荷单次 JSON.parse 宽松归一 | subset 校验 violations | repair 3 / nudge 1 |
| **B 命令** | `acceptance.command` | `verify/started` → 沙箱执行 → `verify/result`（intent-result 对，B-10） | exitCode === 0 | attempts 3 |
| **C 评审**（期 2） | `critic.type` | spawn critic 子代理 → 终态文本抽 verdict/reopen 提案 → 提案本身过 schema（W5 自举） | 提案裁决 | iterations 3 |

**Tier B 执行边界（v2 修 B-13）**：恒 contained 沙箱，但 containment 按父会话同一 fence 解析
（writable/protectedPaths 同约束——contained 决策免弹窗，但**不比父的 bash 面更宽**；原
「不走权限面」表述弃）。无 srt 运行时 → 带该档的装配拒（fail-closed）。

**prompt 增补（v2 补，W5 派生）**：派发时对 prompt 追加结构化交付指令（"完成时最终回复
输出符合 schema 的 JSON"+ schema 摘要）；repair 铸文同样携带 violations 与 schema 提示。
没有它 Tier A 首轮必拒、白烧预算。

### 8.3 反馈铸文与幂等标记（W4 + R1）

所有注入子代理的文本（回炉反馈/恢复 kick/重放 prompt）首行带确定性标记：

```
[wf task <taskId> attempt <n>]
<可修的纠正信号：violations（指向模型可修改的值）+ schema 提示 / 续跑指令 / 原任务>
```

幂等判据 = 该标记在目标会话 WAL 中的存在性（grep 事实序）；截断复用 reportCap。

## 9. 外部契约（工具面）

```
workflow_submit {
  description, prompt,
  subagent_type?, model?, isolation?,          # 透传 delegationView.spawn
  depends_on?: string[],                       # 期 2（v2 标注：期 1 schema 不含此参——承诺不谎报，R4）
  result_schema?: JsonSchema,                  # Tier A
  acceptance?: { command: string, cwd?: string },   # Tier B
  critic?: { type: string, focus?: string },   # Tier C（期 2）
  max_attempts?: number                        # 回炉预算统一覆盖
} → 返回 agent_spawn 同款 spawn 文本 + 尾行回执 `[workflow] taskId: t-<runId> (run <runId>)`
  （后台异步 + 反轮询引导；taskId = `t-<runId>` 跨 run 唯一——终审 A8：同会话并发多 run 的
  stop/notify 判据；模型从回执取 taskId 而非结构化对象——与 agent_spawn 契约同构）
```

- 校验：三档全缺 → **直通（W6：零 journal、settlement 不设、返回 agentId 双填）**；
  Tier B 在场而 sandbox 缺席 → invalid-args 拒；depends_on 期 2 开（环/悬空校验随行）
- 描述工程：与 agent_spawn 分流判据双向写明（spawn 追加"需验证的交付用 workflow_submit"
  引导句——规格正文不动、本仓扩展尾部 append，件15 D6 先例；workflow_submit 描述含直通声明）
- 完成通知 `[workflow-notification]`：outcome/attempts/verdict/证据尾料/子会话指针；
  **每任务一条不聚合**（T1 取舍落档）
- **task_stop 让位协议（v2 修 A4-2；v3 补源协议细节——B2-08/F11-A4）**：agent 源 probe 对
  managed 行返回 miss（实施位 task-source.ts）→ 路由落 workflow 源（kind 字典序
  agent<bash<workflow，workflow 恒末源）。**workflow 源协议三则**：① probe 判据 = run 目录
  header 扫描（taskId ∈ run 且 parentSession === caller；启动扫描的 fold 缓存复用，冷启动
  单次盘扫）三态 hit/denied/miss；② stop 成功文案 `stopped <taskId> (run settled: cancelled)`；
  ③ 失败 reason **以 `not-found:` 开头 = 迟到 miss 续走余源**（TaskSource 协议纪律，词表错
  前缀 = 双源遮蔽换形态复发）。stop 的清理归属：workflow 源 stop → journal 落账 → 调接缝③
  `view.settle(agentId, cause)`（cancel/清树/摘行 delegation 侧完成，与正常 settle 同路）。
  期 1 run 单任务：停任务即停 run；多任务语义期 2 定
- depends_on 引用直通 taskId（agentId 形）的歧义：期 2 落档时给专门文案或支持
  agentFinished 事件等待（F9 设计债标注）

## 10. 状态机（fold 规格；v2 补传播规则）

```
task: submitted → dispatched → (verifying ⇄ repair-issued)* → settled
      submitted ──(spawn 拒)──→ settled{failed, dispatch-failed}        # A5-1
      settled{cancelled} ←─ dependency-failed / circuit-break / task_stop  # A4-1
run:  created → 全 task 终态（含级联取消）→ settled{completed|failed}
      熔断：连续 N failed → 未终态任务级联 settled{cancelled, circuit-break} → run settled{failed}
      run 终态后的迟到 task/settled：收编为 run 后事件（§7）
```

readiness（期 2 全量启用；期 1 单任务退化恒就绪）：depends_on 全 settled-completed 才就绪；
**依赖任一非 completed → 下游 settled{cancelled, dependency-failed}**（不悬置不死锁）。

## 11. 测试计划（v2 补审查点名的假绿面）

| 层 | 内容 |
| --- | --- |
| core 穷举 | fold 全事件序（含 dispatch-failed/级联取消/run 后事件收编/非法转移拒）；readiness 拓扑/并发/熔断/依赖传播；裁决矩阵（三档+组合链+预算扣减+宽松归一三分支） |
| delegation 接缝 | spawn(settlement token 寻址/缺席=普通)/revive(重建行/类型缺失拒)/**四处豁免各一用例**（收养跳过/档化跳过/级联跳过/通知改投）+ **普通路径不回归双向断言** |
| 插件单测 | journal（读写/撕裂/锁双开/死锁接管/header 损坏冻结）；resolve 三链；W6 直通（**断言 root 无新 run 目录**——A3 假绿面）；Tier A 全旅程（含 prompt 增补在派发文本中的断言）；Tier B（exit≠0 回炉/intent-unknown 处置/沙箱缺席拒/fence 约束）；通知（活父/死父悬置/**sessionCreated 边沿补投**）；幂等（标记存在性判据：重复恢复不双注入） |
| 崩溃恢复 | §5.2 二维表**逐行** kill -9 旅程断言（含「completed 直接进验收不重跑」「verify unknown 不重跑命令」**副作用计数断言**——B-10） |
| 并发 | 双进程共享 root：作用域过滤（他 run 不动/活锁跳过/他父跳过）——A8 |
| 边界 | 恢复期 delegation 缺席 → 冻结不失败（R2）；pluginVersion 不符 → 只读（A5-2）；/new 会话切换 → run 存续可查不重绑（A-R5 落档语义锚）；**settlement 投递失败 → 兜底回收路径（F1）**；**hub 优雅停机 → 子随进程消亡 + 恢复走 interrupted 行（F2——断言不停留在「冻结」表述）**；**边沿微任务时序（sessionCreated 后句柄必在，F14）**；**workflow dispose 序列（F3）** |
| e2e | delegation 旅程回归 + workflow 三档各一条含崩溃窗口 |
| 假绿对抗 | 描述↔schema↔行为对账双向；「删接线仍绿」抽查（D1 教训制度化） |

## 12. 分期（v3 重切：恢复不外切，切验收面 × 宿主——复审焦点 4 独立判断采纳）

**切分依据**：恢复与豁免是同一语义单元不可拆（W2 生产底线；砍恢复的降级版里豁免面变纯
泄漏源——不是降级是危险品）；可切的是 Tier B（唯一引入进程外副作用的档：fence/副作用双跑/
cancel×verify 竞态全在它——两轮复审发现最密集的交互区）与 hub 宿主（worker 停机序专门旅程）。

- **期 1a（最小生产切片）**：core 全量 + journal/锁/resolve + delegation 四接缝五豁免 +
  workflow_submit（限根会话）+ **Tier A 全旅程** + §5.2 表 Tier A 可达行恢复 + W6 直通 +
  通知/补投（含边沿微任务时序）+ **CLI 单宿主** + workflowKit。1a 用 Tier A 把
  journal/锁/状态机/豁免/恢复在真实使用中打磨。
- **期 1b（验收面与宿主加宽）**：Tier B（intent-result 对/unknown 处置/fence 按子会话/
  副作用计数断言）+ task_stop 让位（task-tools kind 扩展与源协议）+ **hub 宿主**（停机
  旅程/fields.env 注入）+ 双进程共享 root 并发用例。
- **期 2（已交付）**：会话重绑（run/rebound 归属迁移 + 未认领 run 盘上迁移 + coldIndex 同步）/ Tier C
  critic（W5 自举提案校验 + reopen 回炉 reopens 预算 + 异常终态不回炉）/ depends_on（形态校验 +
  悬空 fail-fast 拒 + readiness 四值消费 + 依赖失败传播——多任务 run 的图校验随多任务提交开放）/
  收尾四项（标记收窄 user/message、冷启动 stop、run GC 三防线、0600 收权含接管路径）。
- **期 3 已定路线**（两路对抗审查后修订）：
  1. **e2e 崩溃旅程**（首位——§11 承诺"三档各一条含崩溃窗口"但 packages/e2e 零 workflow 引用；
     件 16 最复杂的 §5 恢复协议无跨进程 kill -9 回归）
  2. **task 级 wall-clock deadline**（类修非点修：child 挂起 + critic 挂起同病——静默 wedge
     且无用户止损面；政策类比 Tier B timeout→failed→预算内 reject；~1 天按本仓交付节奏）
  3. 已随路线评审即做（本提交）：通知携带已验收交付物（B-9 第一痛点）/ depends_on 描述
     诚实化 / T-2 run 级 outcome 语义 / hub 侧分流引导句 / CLI 引导句恒接线
- **观察项（多任务 run）**：引擎侧已按多任务铸造（fold/readiness/notify 天然多任务），插件面
  缺口集中（多任务提交面 + dispatch-on-settle 边沿 + 并发窗与 delegation maxConcurrent 协调 +
  熔断阈值决策——circuitBreak 现硬编码 0 即死码）。触发指标（telemetry 现成可查）：
  ① workflow_submit 因 depends_on 被拒计数；② 同会话通知→下一提交的链式间隔分布；
  ③ 每链父会话 turn 数。任一持续超阈值即启动；观察期上限一个里程碑周期。
- **不做项（挂账+诚实成本）**：
  - step-boundary 反馈：**无参数位**（feedback_timing 仅存在于本文档两处文字，schema/
    TaskSpec/铸文/恢复幂等四处均需新增——非"填参数"）；重启条件=实测 repair 轮 token 开销
    成为主要成本项。真实架构成本：settlement 以 idle 边沿触发验收，in-turn 修复需 mid-turn
    评价面（接缝重造）。W4 的"期 2 参数"承诺已失效，特此更正。
  - 幂等 nonce：D1 收窄（user/message 限定）已关主面且残余路径后果自我抵消（伪造=少挨
    一次 kick）；不独立排期，与多任务 run 捆绑（依赖传播会放大停滞面时一并做）。

### 12.5 实施顺序（每步四门 + 独立可回滚——对照件13 六阶段纪律，v2 缺此节被点名）

```
① workflow-core（纯函数 + 穷举测试——零依赖可先行）
② journal/锁/resolve（写面 + 恢复矩阵单测——I/O 层独立验证）
③ delegation 四接缝 + 五豁免（含普通路径不回归双向断言——delegation 包内独立提交）
④ Tier A 装配 + workflow_submit + W6 直通（CLI）
⑤ 恢复协议（§5.1/5.2/5.3 全链 + kill -9 旅程）
⑥ Tier B + task_stop 让位 + hub 宿主（期 1b 起点）
```

e2e 装置需求（B2-09——三件均有先例可克隆）：kill -9 驱动夹具（cross-peer 式子进程）/
双进程共享 root 对端/副作用计数装置（约定 append 计数文件）。

## 13. ZCode 审计结论（设计输入留档）

保留：编排旁挂窄端口 / 事件溯源 journal / typed 校验（W5 诚实版：校验 typed，通道 steer）/
有限回炉预算 / 持久上下文（子会话 WAL+revive——审查后升级为显式接缝②）/ in-turn 修复的
token 经济性（期 2 参数形态）。
弃：TS 编译器+facade+taint 全套 / 双账本互写（§4 纪律+豁免边界）/ 静态八阶段 / 验收策略
无统一抽象（W3 两层）/ critic prompt 约定裸解析（W5：抽取靠 prompt 增补 + 校验兜底，不裸） /
预算硬编码 / 单任务走全套引擎（W6 零足迹直通）。

## 14. 落档（不做与挂账）

| 项 | 状态 |
| --- | --- |
| 跨会话记忆沉淀 | 挂账——journal 是事实源，挖掘口开放 |
| 反馈注入 step-boundary（真 in-turn） | 期 3 候选（W4 参数位保留） |
| 人工验收/外部 CI Acceptor | 接口开放（W3），按需实现 |
| ~~run 目录 GC~~ | **期 2 已交付**（settled+已通知+无活锁 超龄删——三防线） |
| workflow 级并发上限 | 期 2 随 DAG |
| ~~run 随 /new、/resume 的重绑~~ | **期 2 已交付**（run/rebound 事件 + runtime.rebind + workflowView 服务面） |
| spec 原样落盘的演进语义 | 已接受取舍（§4：裁决可随实现演进，版本不符只读） |

## 15. 首轮审查处置表（A 路 8 真缺陷 + 9 风险 / B 路 9 真缺陷 + 5 风险；v2 全量处置）

| 发现 | 级别 | 处置（落点） |
| --- | --- | --- |
| A1/B-02 loop.resume 不进 lineage、不 kick → 恢复死循环 | 真缺陷 | §6 接缝② view.revive + §5.2 显式 kick 文本（带幂等标记） |
| A2/B-01 父死触收养处死受管子 / 回炉反馈被父预检拦 | 真缺陷 | §6 接缝③ 收养+父预检豁免（W8）；§5.4 运行期父死语义 |
| B-01 delegation dispose/stopAll 级联灭受管行 | 真缺陷 | §6 接缝③ 级联豁免；hub 停机 = run 冻结 |
| A3 W6 直通 journal 僵尸/契约撒谎 | 真缺陷 | W6 改零足迹 + §11 断言 root 无新目录 |
| A4/B-09 依赖失败死锁 / task_stop 双源遮蔽 / run 后事件 | 真缺陷 | §10 依赖传播规则；§9 让位协议；§7 run 后事件收编 |
| A5 dispatch 拒无事件可落 / pluginVersion 虚设 | 真缺陷 | §7 dispatch-failed 落账；§4 版本不符只读规则 |
| A6 evidence 违反 §4 纪律 | 真缺陷 | §4 证据尾料豁免边界（critic 报告只落指针） |
| A7/B-04 W5 typed 通道在 W4 下不可兑现 / managedBy 类型错配 / critic 归属 | 真缺陷 | W5 诚实化（校验 typed 非通道）；§6 接缝① token 替 SessionId + critic caller 归属写死 |
| A8/B-06/B-07 全量扫描无作用域 / run 锁空话 | 真缺陷 | §5.1 三条过滤；§3.1 lock.ts 全套 |
| B-08 恢复触发时机不存在 | 真缺陷 | §5.3 sessionCreated 边沿 + apply/边沿分工 |
| B-05 revive 包内私有 → 复制即双真相 | 真缺陷 | §6 接缝② 显式暴露 |
| B-03 submitted 后孤儿窗口 | 真缺陷 | §5.2 表行 2 + 启动清扫 |
| B-02 窗口按子 WAL 终态分类 | 真缺陷 | §5.2 二维表 |
| R1/B-11 steer 幂等无判据 | 风险 | §8.3 确定性标记（首行）为幂等键 |
| B-10 命令副作用双跑 | 风险 | §7 verify intent-result 对 + unknown 处置 + §11 副作用计数断言 |
| B-13 Tier B 绕 permission broker | 风险 | §8.2 containment 按父 fence 解析 |
| B-14 受管行占槽泄漏 | 风险 | §6 接缝③ 档化豁免的反面：settle 驱动 dispose+摘行（归还常规路径） |
| A-R3 Acceptor 纯函数装不下 IO | 风险 | W3 两层（采集器 async / 裁决器纯） |
| B-12 装配清单缺 archive/session | 风险 | §2 plugin inject/softInject 修正 |
| A-R4 depends_on 期 1 谎报 | 风险 | §9 标注期 2，期 1 schema 不含 |
| A-R5 会话切换 run 漂移 | 风险 | §14 落档期 2 重绑，期 1 存续可查 |
| A-R6 熔断时在飞兄弟任务 | 风险 | §10 级联 settled{cancelled} |
| A-R7 spawn 缺 caller / critic to:main 绕道 | 风险 | §6 接缝① caller 首参 + critic 结算 token |
| A-R8 锁判据含糊 | 风险 | §3.1 lock 文件全套（并入 B-06 处置） |
| A-R9 evictIdle 互作 | 风险 | §6 接缝③ 档化豁免 |
| T1-T4（通知不聚合/tier 字段/依赖口径/owner 措辞） | 取舍 | §9/§7/§2/§6 各落档 |
| U1 关系表述 | 焦点 | 头部重写：run 级协作 vs 常驻 teammate，正交+演进关系 |

### 二轮复审处置（v2→v3；A 路 F1-F15 / B 路 B2-01~10）

| 发现 | 级别 | 处置（落点） |
| --- | --- | --- |
| F1 settlement 投递/落账失败 → 完成事实永久丢（豁免封死兜底） | 真缺陷 | §6 接缝④第五条：settle 失败兜底回收 + `settled{failed, settle-failed}` |
| B2-01 revive 不带 settlement → 恢复行绕验收/被处死 | 真缺陷 | §6 接缝②签名加 settlement 透传（重建为受管行） |
| B2-02 settle 归还无面可调（stopAll 误杀/私有面够不着） | 真缺陷 | §6 接缝③ view.settle(agentId, cause)——接缝 3→4 |
| A-F2 「优雅停机=冻结/受管行存活」与机制事实相反 | 真缺陷 | §5.4 重写：存活仅限进程内窗口；停机=同崩溃恢复路径 |
| A-F5 task 终态后 verify 迟到无收编规则 | 真缺陷 | §7 后事件收编扩到 verify/* + cancel 同步落 unknown 封口 |
| A-F6 repair-issued 行折叠三终态各自悬死（error 终态烧预算） | 真缺陷 | §5.2 行拆细：completed→验收/interrupted→kick/异常终态→settled{child-failed} 不进验收 |
| A-F7 幂等标记 inbox 未消费 ≠ 已送达 | 真缺陷 | §5.2 幂等判据改「已材料化消息」；未起跑行防双份排队 |
| A-F8 mid-flight 崩溃盘上无 turn/end 落不进任何行 | 真缺陷 | §5.2 终态判定算法：fold + 开放 turn/start 合成 interrupted（扫描器职责） |
| A-F12/B2-04 lock「pid+bootId」与 lock.ts 实物不符 | 真缺陷(低) | §3.1 照实 pid-only；pid 复用 30s 窗落档 |
| A-F13 子代理提交的 run 永无认领者 | 真缺陷 | §5.1 期 1 工具限根会话（notify_when_idle 先例）；live 集扩展期 2 |
| A-F14/B2-06 sessionCreated 早于句柄登记 / 条件② apply 无值 | 真缺陷 | §5.3 微任务延迟入方案+断言；workflowKit 加 mainSession 参 |
| B2-03 Tier B×worktree fence/cwd 失配（验收恒假拒） | 真缺陷 | §8.2 cwd 与 fence 都按子会话解析（rootOverride=worktree，比父窄）+ settle 前时序约束 |
| B2-05 journal 中段行损坏缺处置 | 风险 | §3.1 恢复矩阵补冻结行 |
| A-F3 workflow 插件 dispose 序列零字 | 风险 | §2 dispose 序列节（沙箱 abort→fsync→锁不显式释放→受管不 cancel） |
| A-F15 apply 全量 fold 无上界 | 风险 | §5.1 header 剪枝先行 |
| B2-08 workflow 源 probe/stop 协议未定 | 风险 | §9 源协议三则（判据/文案/not-found 前缀纪律）+ stop 清理归接缝③ |
| B2-09 e2e 装置缺口三件 | 风险 | §12.5 装置需求点名（kill-9 夹具/双进程对端/副作用计数） |
| A-F4 token「delegation 活 workflow 死」可达性 | 验证 | 已验证不可达（同 world 同死）——前提锁定写进 §6 接缝④ |
| B2-07 softInject 宪法张力 / 装配期拒措辞冲突 | 取舍 | §6 解析动词写明（softInject topo 先装 + apply tryUse）；Tier B 统一运行期拒 |
| B2-10 schema 摘要上限未定 | 取舍 | §8.2 独立小上限 2000 字符 |
| A-F9 直通 taskId 被 depends_on 引用歧义 | 风险(期2) | §9 设计债标注 |
| A 焦点4：期 1 过胖 | 判断 | §12 重切 1a（Tier A+恢复+CLI）/1b（Tier B+让位+hub）+ §12.5 实施顺序 |
| B2 可实施性正面结论 | 验证 | 四豁免精确到行（stopAll 在 plugin.ts:407 非 verbs.ts）；跨服务传回调先例 permissionBroker.ask；锁竞态协议直接适用；TypeBox violationsOf 复用为 Tier A 裁决器 |

### 期 2 实现对抗审查处置（两路：A 功能正确性 / B 回归边界）

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| R1/D-1 critic 预算永不扣减（误落 repair-issued 计 repairs——无界活循环实测 20s 1756 轮） | 真缺陷 | reject 落 task/reopened（reopens 联动）；预算断言假绿修正（critic:budget-exhausted 锚） |
| R2/D-2/D-3 rebind 后 critic/恢复 caller 冻结（与 R1 叠加为不可收敛死循环） | 真缺陷 | critic 收 mainRef.current；deps.mainSessionRef 回填（reviveAndKick 活 caller） |
| R3/D-4 GC 删 settled-未通知 run + 锁活竞态 + 扫描 mkdir 竞态 | 真缺陷 | notifiedAll 条件 + 锁探测（序在 age 后——探测 touch mtime）+ 扫描→GC 串行 |
| D-5 rebind 半程失败永不补迁移（判据 ≠ previous 在中断后永假） | 真缺陷 | 幂等判据（header ≠ next 即迁——失败可补） |
| K2/D-7 rewriteHeaderParent 非原子 + 0644 放宽 | 真缺陷 | temp+rename 原子写 + mode 0600 |
| K4/D-6 coldStop 无 finally（fd+锁泄漏） | 真缺陷 | try/finally |
| R-1 stop critic → 又 spawn 新 critic | 风险 | sink 异常终态直接终局（不回炉） |
| R-2 未认领 run 归属滞留旧会话 | 风险 | rebind 盘上迁移（busy 跳过）+ coldIndex 同步 |
| R-5 gcRuns 返回值失实 | 风险 | rm 失败不 push |
| K1/K3/K6/T2 | 风险 | redispatch 就绪检查/接管 chmod/自依赖拒/阶段叙事清除 |
| R-3 critic 无超时面 / R-4 自注入伪造 nonce / T-2 run 级 outcome 混合 | 挂账 | 期 3 候选 |
| 假绿：critic 预算断言碰巧绿 / rebind 在飞迁移零覆盖 / 空转用例虚增 | 假绿 | 断言锚定 + 真在飞窗口用例 + 死用例删除 |

### 实现终审处置（三路：A 忠实性 / B 并发泄漏 / C 安全假绿——v3.1 全清）

| 发现 | 级别 | 处置 |
| --- | --- | --- |
| C-D1/A4/B3 Tier B cwd 默认宿主 cwd——worktree 任务验错树 | 真缺陷 | cwd 链：显式 > rootOverride（子会话）> 宿主 cwd |
| C-D2/B2 verify 崩溃窗口重跑命令（B-10 复发） | 真缺陷 | verifying 态 closeDanglingVerify+unknown 封口+终局；stopTask 同步封口 |
| C-D3 非 sandbox execEnv 裸奔（local 面） | 真缺陷 | env.kind !== sandbox 运行期拒 |
| C-D4/A5 恢复路径 fence 锚用 agentId | 真缺陷 | deliverToAcceptance 传真 sessionId |
| C-D5/B1 settlement 失败吞掉（第五豁免未兑现） | 真缺陷 | onSettleFailed 显式兜底回调（settle 归还+onWarn） |
| C-D6 分流引导句单向缺失 | 真缺陷 | DelegationOptions.spawnDescriptionAppend 通道（kit 组合）+ CLI 接线 |
| C-D7 通知三处过度承诺（evidence/session/attempts） | 真缺陷 | 铸文补 session 行 + attempts 全档口径 |
| C-D8/B4 命令无超时/无输出上限 | 真缺陷 | 120s 两段杀 + 1MB 上限（可注入） |
| A3 submitted 无锚永久 wedged | 真缺陷 | runtime.redispatch 重派发（活父）/悬置（死父） |
| A6 --workflow-dir 未注册（死参数） | 真缺陷 | FLAG_SPECS/copy/usage + parse 回归 |
| A7 无锁撕裂回写毁他进程活跃卷 | 真缺陷 | recoverJournal repair 参数（持锁才回写） |
| A8 taskId 恒 t1 跨 run 歧义 | 真缺陷 | t-<runId> 前缀化 + submit 文本回执 |
| B5 settled 未投通知跨重启永久丢 | 真缺陷 | 扫描认领补投+收尾（唯一跨重启收敛路径） |
| B7 archive 缺席认领即锁泄漏 | 真缺陷 | 未终态 run 冻结不认领 + onWarn |
| B8 恢复终局 run 不摘 maps（缓泄+probe 误 hit） | 真缺陷 | runtime.detach 面 |
| B-11 settleRun 无条件删 run（悬置丢通知） | 真缺陷 | 悬置感知留驻 + onSessionAlive 补投后归还链 |
| B9 dispose 未 await（fsync 可能被截断） | 风险 | disposer 返回 promise |
| C-G1/G2 恒真断言 + 前提不成立（假绿） | 假绿 | 级联豁免真断言；deliverToRow 豁免父真 dispose |
| C-G3 evictIdle 豁免零覆盖 | 假绿 | maxResident=1 压迫用例 |
| C-G4 回炉用例时序竞争 + 不断言 passed | 假绿 | 计数文件自愈命令 + passed 终态断言 |
| C-G5 手术产出 repairing 误标 dispatched | 假绿 | dispatched×completed 专窗（不 revive/kick 断言） |
| B-F14 微任务假设在重建场景不成立 | 时序 | 句柄轮询等待（2ms×≤50 拍） |
| A-17 直通未限根会话 | 取舍 | 保持现状落档：直通字节级等价 agent_spawn（对所有会话开放是既有语义的自然延伸，无实害）；F13 限根条款收敛为「受管路径」限根——措辞已在 W6 注明 |
| C-R2/R3/R4/R5/R6 + A-R9~R19/B-R10~R16 | 风险/取舍 | 逐项核对：R2 幂等标记伪造（方案级——期 2 收窄 user/message 或 nonce）/R3 注入链与 bash 面等宽（已接受）/R4 journal 明文（GC 前建议 chmod 0600）/R5 /new 工具死亡（期 2 重绑）/R6 probeTask 冷启动盘扫（期 2）等——落 §14 |
