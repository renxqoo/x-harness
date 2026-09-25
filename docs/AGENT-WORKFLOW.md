# AGENT-WORKFLOW：验收回炉与任务编排终态（件 16）

> 状态：**方案定稿 v2**（首轮两路对抗审查 A/B 共 17 真缺陷 + 14 风险全处置，处置表 §15）
> 级别：高（agent-workflow-core 新包（纯引擎）+ agent-workflow 新包（插件）+ agent-delegation
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
packages/agent-workflow-core/     纯引擎（零 IO：不依赖 agent-loop/session/delegation）
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
两宿主经 `workflowKit({ root, budgets? })`（harness 包）装配——不装即无此面，行为与现状全等。

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
- **run 占有 = lock 持有**（v2：原「header 活」无判据——SessionHeader 无活性字段）；
  锁持有者 = 该 run 的驱动进程；崩溃后按 pid 活性 + 接管窗重认领
- **恢复矩阵**（v2 补，journal 异常态的处置）：目录被外部删除 → 等价 run 不存在（子会话
  WAL 仍在，可手动 revive，onWarn）；header 半写/损坏 → run 冻结 + onWarn（不自动重建）；
  journal 中行损坏 → 撕裂截断到最后完整行 fold（前缀语义），截断处之后事件丢弃 + onWarn

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

plugin.apply 时：扫描 workflowRoot 全部 run → 对每个 run 先 fold 记账 → **只对满足全部
三条的 run 执行恢复动作**：
1. lock 可接管（无锁/死锁）——活锁 run 属他进程驱动，跳过不报错
2. `header.parentSession === 本进程主会话`（或主会话将 resume 的 id）——他父的 run 跳过
3. `header.pluginVersion` 与本插件兼容（不符 → 只读不补动作，§4）

跳过即跳过：不失败装配、不改状态——多进程共享 root 安全。

### 5.2 二维窗口表（journal 末事件 × 子会话 WAL 终态，堵 B-02/B-03）

| journal 末事件 | 子会话 WAL 终态 | 恢复动作 |
| --- | --- | --- |
| `run/created` | （无任务） | 静默续 |
| `task/submitted` | 无 dispatched 后续 | 重派发（spec 在 journal）；若存在同 agentId 孤儿子会话（spawn 后未落账即崩）→ 经启动清扫语义处理孤儿树（B-03） |
| `task/dispatched` | 末 `turn/end{completed}` | **直接进验收**（子已干完——不唤醒不重跑，白烧一轮） |
| `task/dispatched` | `interrupted`（repair 已闭合） | `view.revive` 重建 lineage 行 + **kick 文本唤醒**（loop.resume 不自动 kick——A1）："continue task <taskId>；上下文已恢复" |
| `task/dispatched` | 从未起跑（无 user 消息） | revive + 重放原 prompt'（prompt 增补从 spec 重铸） |
| `task/repair-issued` | 任意 | revive + **按幂等标记判**（§8.3）：子 WAL 已含 `[wf <taskId> a<n>]` 标记 → 反馈已送达，等修复；未含 → 补注入 |
| `verify/started`（Tier B） | — | **无 `verify/result` 配对 → 落 `verify/result{outcome:unknown}`，任务按 fail 处置**（B-10：不盲目重跑——副作用可能已发生）；有 result → 走正常裁决 |
| `task/settled` | — | 无 `notify/delivered` → 补投（§5.3）；已投 → 静默 |
| `run/settled` | — | 静默归档 |

**唤醒/反馈/通知全部幂等**：判据 = 确定性标记（§8.3）在子会话 WAL / 父会话 WAL 中的存在性
——不依赖 entry id（loop 内部铸造不回传，R1）。

### 5.3 补投触发边沿（堵 B-08）

两宿主装配序都是插件 apply 先于主会话建立——apply 时刻的「死父」无法补投。规则：
- **apply 时**：只 fold 记账 + 对「不需要父」的动作（revive 续跑、验收执行）立即执行
- **主会话建立/复活边沿**（sessionCreated 事件 / 宿主 resume 完成回调）：触发重扫 →
  补投悬置通知（插入序先于用户首条消息处理）+ 派发就绪任务（spawn 需活父句柄）

### 5.4 运行期父会话死亡（W8 的兑现）

受管子代理**不**随父 dispose 中止（豁免孤儿收养，§6-③）；继续跑完 → 验收 → settle →
通知悬置落 journal；父 resume（任意进程）时按 §5.3 边沿补投。hub worker 停机：受管行
豁免 stopAll（B-01）——worker 优雅停机落 `run 冻结`（journal 不动，等下次认领续跑）；
worker 被杀（SIGKILL）同崩溃恢复。

## 6. delegation 接缝（v2：三个，均为原语非策略）

1. **`delegationView.spawn(caller, input & { settlement?: SettlementToken })`**
   服务面补全（caller 首参与既有四动词同构——R7）。`settlement` 是**不透明 token**（v2：
   弃 SessionId——workflow 无会话身份，SessionId 会与「直达父」路由同键，B-04）：在场的
   子代理行挂受管标记，完成通知改投 token 寻址的结算入口。Tier C critic 的 spawn 同走此面
   （caller = 提交会话——critic 的 parent/占槽/depth 归提交会话记账，其完成投 critic 结算
   token，不经 to:main 绕道，R7）。
2. **`delegationView.revive(caller, agentId)`**
   既有 reviveByAgentId 的服务面出口（v2 新增：原为包内私有，恢复链必需——复制即双真相，
   B-05/A1）。语义与 message 复活链同源：按 header.agentId 重建 lineage 行 + 拨号/白名单/
   worktree 重放；类型 .md 缺失 → fail-closed 拒（任务落 `settled{failed, type-def-missing}`）。
3. **受管行生命周期豁免（W8）**
   delegation 四处对 managed 行的行为修改（不变量④显式修订，独立单测锚）：
   - 孤儿收养（adoptOrphan / deliverToRow 父存活预检）：跳过——受管子不因父缺席被处死
   - evictIdle 档化：跳过——repair 等待窗内不被踢（R9）
   - stopAll / 插件 dispose 级联：跳过 cancel/dispose/清树——宿主退出受管行存活（B-01）
   - 完成通知：投 settlement token 而非直达父
   子代理的最终 dispose/清树/摘行由 **workflow settle 驱动**（run 终态后归还 delegation
   常规路径；崩溃残留由下次恢复清扫）。

接缝实现落 agent-delegation 包内（view.ts/plugin.ts/notify.ts/lineage.ts/verbs.ts 五文件），
每处带独立单测（受管分支 + 普通路径不回归双向断言）。agent-workflow softInject 消费：
delegation 缺席 → 受管 workflow_submit 拒 invalid-args（运行期 fail-closed）；**恢复期**
发现 in-flight run 而 delegation/archive 缺席 → run 冻结 + onWarn，不失败装配（R2）。

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

run 终局后迟到 task 事件的合法性（v2 补，堵 A4-3）：**允许落账**（熔断/取消时在飞任务的
`task/settled{cancelled}` 天然晚于 `run/settled`）——fold 对 run 终态后的 task 事件收编为
「run 后事件」，不拒不弃（词表 fail-closed 指类型未知，非时序未知）。

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
} → { taskId, runId }（后台异步 + 反轮询引导）
```

- 校验：三档全缺 → **直通（W6：零 journal、settlement 不设、返回 agentId 双填）**；
  Tier B 在场而 sandbox 缺席 → invalid-args 拒；depends_on 期 2 开（环/悬空校验随行）
- 描述工程：与 agent_spawn 分流判据双向写明（spawn 追加"需验证的交付用 workflow_submit"
  引导句——规格正文不动、本仓扩展尾部 append，件15 D6 先例；workflow_submit 描述含直通声明）
- 完成通知 `[workflow-notification]`：outcome/attempts/verdict/证据尾料/子会话指针；
  **每任务一条不聚合**（T1 取舍落档）
- **task_stop 让位协议（v2 修 A4-2）**：agent 源 probe 对 managed 行返回 miss（kind 让位）
  → 路由落 workflow 源 → stop = 子 cancel + `run/settled{cancelled}` + journal 落账。
  期 1 run 单任务：停任务即停 run；多任务语义期 2 定（依赖失败传播同期）
- task-tools 侧实现动作：kind 词表扩 `workflow`、not-found 文案更新（实现期清单，非方案面）

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
| 边界 | 恢复期 delegation 缺席 → 冻结不失败（R2）；pluginVersion 不符 → 只读（A5-2）；/new 会话切换 → run 存续可查不重绑（A-R5 落档语义锚） |
| e2e | delegation 旅程回归 + workflow 三档各一条含崩溃窗口 |
| 假绿对抗 | 描述↔schema↔行为对账双向；「删接线仍绿」抽查（D1 教训制度化） |

## 12. 分期

- **期 1（本期）**：core 全量 + journal/锁/resume/resolve + delegation 三接缝（含四处豁免）+
  workflow_submit + **Tier A + Tier B 完整**（含 §5.2 全窗口恢复旅程）+ 两宿主装配 +
  workflowKit + task_stop 让位协议。交付即生产可用。
- **期 2**：Tier C critic + depends_on DAG（readiness/传播规则已就绪）+ feedback_timing
  step-boundary 参数 + run 随会话切换重绑（rebindMailbox 对齐）+ 多任务 run 的 stop 语义。

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
| 反馈注入 step-boundary（真 in-turn） | 期 2 参数（W4） |
| 人工验收/外部 CI Acceptor | 接口开放（W3），按需实现 |
| run 目录 GC | 挂账——与 session 目录同策略统一收口 |
| workflow 级并发上限 | 期 2 随 DAG |
| run 随 /new、/resume 的重绑 | 期 2（期 1 语义：run 锚 parentSession 存续，新会话可读 journal 查询，不自动重绑——A-R5） |
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
