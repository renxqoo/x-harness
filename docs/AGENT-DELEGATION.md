# AGENT-DELEGATION：子代理插件（件 9）

> 状态：已实施（方案审 A/B + 代码审 A/B 四路处置见 §6/§8；e2e 旅程绿）
> 级别：中（跨包新件 + agent-loop/tools 两处接缝扩展 + 子代理生命周期并发语义）
> 参考思想：my-agent agents 件（异步 spawn/通知唤醒/动词族/门禁——实现逻辑主参考）、
> DSH subagent 族（max-depth/结算映射/孤儿防护）。测试语义子集 X1–X20 已提取对照（§5）。

## 0. 动机

生产 agent 必须能并行拆解任务：父模型经工具派生子代理（独立会话、可受限工具集、可继承
上下文），子完成主动唤醒父继续——父的模型上下文不被子过程污染。地基已备：AgentHandle
动词族（followup/steer/cancel/whenIdle）、session fork、agentStatus 事件冒泡（子 scope emit
可达根层监听者）。

## 1. 契约

```ts
export interface SubagentType {
  readonly prompt?: string;                 // 子 system prompt（缺省=装配默认）
  readonly model?: string;                  // 缺省=父模型
  readonly provider?: string;
  readonly tools?: readonly string[];       // 工具白名单（沿树只收窄：∩ 调用方白名单）
}
export interface DelegationOptions {
  readonly types: Readonly<Record<string, SubagentType>>;
  readonly maxDepth?: number;               // 缺省 3；子再派孙超深度拒
  readonly maxConcurrent?: number;          // 缺省 10；按父计在飞（running）子数
  readonly reportCap?: number;              // 缺省 8000；agent_output 报告截断上界
}
export function createAgentDelegationPlugin(options: DelegationOptions): Plugin;
// name "agent-delegation"，inject ["session","tools","agent-loop"]
```

### 1.1 工具族（注册进 toolRegistry，父与子都可见——递归由 maxDepth 管）

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `agent_spawn` | `{prompt, type?, name?}` | 立即返回文本（agentId/sessionId/name + 等待引导）；子后台跑（X1） |
| `agent_message` | `{agentId, text}` | 向子追加输入：子 busy → steer（步边界排队）；idle → 唤醒（X4） |
| `agent_output` | `{agentId}` | 读子会话报告（末轮 assistant 文本，cap 截断文案引导 agent_message 追问——无文件指针）（X11） |
| `agent_stop` | `{agentId}` | cancel + 收敛；幂等（X19）；停止不是销毁——可再 message（X5） |
| `list_agents` | `{}` | 活视图（**限调用方子树**）：agentId/sessionId/name/type/depth/status |

- 寻址主键 = agentId（`agent-` 前缀 + 计数，插件内唯一单调）；同名共存（X13 进程内版）。
- 工具体经 ToolExecContext.session 识别**调用方会话**；**动词工具属主校验**：
  callerSession ≠ row.parent → invalid-args（防跨父猜 id 操纵别家子）。
- 白名单 `undefined` = 全集（沿树只收窄不放宽）。

### 1.2 spawn 决策流（检查序；`agent_spawn` 工具 exclusive——排他屏障串行化检查→登记窗口，关并行超卖）

1. 调用方识别：ToolExecContext.session 缺位（非 agent 宿主直调）→ invalid-args 拒。
2. 类型解析：`fork`（保留）→ 重铸种子 + 父模型；未注册名 → invalid-args + 可用类型清单（X17）；
   缺省 → 无类型（父模型）。**type.tools 含未注册名 → invalid-args 带该名与可用清单**（构造期
   校验不可行——工具注册是运行期行为；spawn 时注册表已就绪）。
3. maxDepth：调用方 depth+1 > maxDepth → 拒（maxDepth=0 即全拒；配置垃圾值构造期 throw，X7）。
4. maxConcurrent：该父名下 **occupied** 子数 ≥ 上限 → 拒（文案带数字与等待引导；spawn 登记
   即占槽、完成通知/stop 即释放，X8）。
5. 建子：`loop.create({session: fork? 重铸种子+parent 血缘 : 全新, agent: {model, provider,
   systemPrompt, tools: 白名单∩}})`（**id 不自铸——store 铸号，agentId 与 sessionId 解耦**；
   父模型/线路从父 options ?? 父末次 request/header 折叠取——全新子无 header）→ 登记 lineage
   （occupied=true, armed=false）→ **create 后 followup 前查 signal.aborted：断则 dispose 子
   再返回（execute 内断信号不遗孤儿子，X20）** → `followup(prompt)`。
6. 返回 content 铸文本：agentId/sessionId/name + 反轮询引导（结束回合等通知，勿轮询 output）。

### 1.2.1 工具并发分类

`agent_spawn`/`agent_stop` = exclusive（检查-登记原子性；stop 含 whenIdle 收敛）；
`agent_message`/`agent_output`/`list_agents` = parallel。

### 1.3 完成通知（X2/X4/X10）

插件根层监听 `agentStatus`（**tearing-down 门：插件 dispose 置位后监听器丢弃一切通知——级联
cancel 触发的 abort 通知不得 steer 复活父**）：表内子 running → `armed=true`；idle 且 armed →
收通知一轮：读子 WAL 末 `turn/end`（**status 词表对齐 TurnEndReason 全集**：completed/aborted/
error/max-tokens/blocked 如实透传；interrupted 透传；未知→fail-closed 按 error）+ **本轮**
（末 turn/end 之后的）assistant 文本摘要 ≤200 字（本轮无 assistant 则略摘要——aborted 轮不回潮
前轮文案）+ usage（若有）→ 铸 `[agent-notification] …` → **`loop.get(parentSessionId).agent.steer`
注入**（父 busy → 步边界消费；父 idle → 唤醒起 turn）；armed=false、**occupied=false（槽释放）**。
父 get 缺位（已 dispose）→ 对该子 `cancel("parent-gone")+whenIdle+dispose+摘表行`（孤儿子不
任其烧请求）；steer 落账失败（父恰在封存）→ try/catch 丢弃（emit 错误隔离不依赖隐式契约）。
已知窗口落档：父 blocked/max-tokens 轮末的滞留通知等下次任意唤醒消费；父被 cancel（未 dispose）
时通知到达会 steer 拉起新轮（通知=新素材，接受）；idle→running 微窗口的双通知语义接受。

### 1.4 fork 种子 = surface 重铸（X14；两路审查 P0 处置——滤除切片破坏 seq 连续与 replace 寻的，机制性不可行）

裸切片不可行（validateSessionEvents 强制 seq==下标；replace 按绝对 seq 寻的）。重铸构造
（delegation 自持，不改 session 包）：父 surface 节点滤至**最后一个 `turn/end`**（完成轮投影
——剔除开放轮与在飞 tool_use，DSH/交集语义）→ `surfaceToMessages` → **逐条重铸全新 append
形态事件**（seq 0..n-1，turn/step 全 0——形状门与投影重放皆过，纯 append 无 replace 寻的）；
父无已完成 turn → 无种子全新子（工具结果文案如实告知）。`create({session: {seed, parent: 父 id}})`
（header.parentSession 血缘落盘）。end-seed 不带 inherited 标记（create 路径语义）——落档。

## 2. 接缝扩展（同提交）

1. **tools**：`ToolExecContext` + `session?: SessionId`（dispatch 透传——wire 上 ToolCallRequest
   已带，最后一米补齐；request-altered 断言已含 session）。
2. **agent-loop**：
   - `AgentLoopService.get(id): AgentHandle | undefined`（delegation 取父/测试用；dispose 摘除）；
   - `AgentOptions.tools?: readonly string[]` 白名单：dialStep 的 schemas 投影过滤 +
     tool-calls dispatch 前置拒绝（`tool-not-allowed:<name>` isError 结果——白名单外拦在
     执行面，X15）。

## 3. 问题域

**处理**：spawn/类型解析/fork 净化/lineage 表（进程内）/完成通知（steer 注入）/动词族
（message/output/stop/list）/maxDepth+maxConcurrent/报告截断/工具白名单沿树只收窄
（effective = type.tools ∩ 调用方白名单）/插件 dispose 级联 cancel+dispose 全部子。
**不处理（落档）**：跨进程 lineage 持久与重启重建（my-agent WAL 表/replay——子会话盘上可
resume，父表进程内）；通知合并窗口/digest（多子同窗=多条 steer，父轮内多消息可接受）；
子 maxTurns/maxTokens 预算（挂账）；子→父 message_main 通道；通知信封闭合标签中和（X18——
报告经 cap 截断，无富信封 v1）；LRU 驻留驱逐；同步前台 delegate 工具；fork 自归档。

## 4. 测试口径（对照 X1–X20 逐条——v1 覆盖项写用例）

- 契约：插件名/inject；配置垃圾值 fail-fast 表（maxDepth/maxConcurrent 负/小数/NaN）。
- spawn：立即返回唯一 agentId、同名共存互不串扰（X1/X13）；未知类型 err 带清单（X17）；
  类型生效（model/systemPrompt/tools 白名单——子请求头 tools 投影只含白名单，X15）；
  白名单沿树收窄（父受限 type 的子再派孙 ∩ 生效）；fork 净化（种子切至最后 turn/end、
  无 inbox 事件、继承父模型——断言子 deriveMessages 首条为父 system）（X14）。
- 门禁：maxDepth=0 拒 / 深度链第 4 层拒（X7）；maxConcurrent 占槽含在途（三 spawn 并发
  挂起流——第三个拒，文案带数字）（X8）；spawn 竞态（signal 已断不建子，X20）。
- 通知：子完成 → 父 steer 注入含 agentId/status/摘要；**父 idle 被唤醒双断言**（turn/start ≥2
  且第二 turn user/message 含通知文本）；**父 busy 步边界路径**（悬停流闸门装置：turn 数不变、
  当前 turn 后续 step 的 user/message 含通知）；子 error turn → status=error；blocked 如实
  透传（X10/P2-1）；aborted 轮不回潮前轮摘要；父 dispose 后子完成 → 孤儿子被收养处置（cancel+
  dispose，lineage 摘行）；插件 dispose 级联 cancel 子且**通知门抑制复活**（级联期父不被 steer）。
- 动词：agent_message busy 排队步边界 / idle 唤醒；agent_output 报告 + cap 截断文案；
  agent_stop 幂等 + 停止后可再 message；list_agents 限子树；**属主校验**（他父会话调动词 →
  invalid-args）。
- 门禁：maxConcurrent=2 + 一条消息三个 spawn tool_use 进并行池 → 第三个拒（exclusive 串行下
  计数不超）；type.tools 未注册名拒带清单。
- X20：spawn execute 内断信号 → 子被 dispose（lineage 无孤儿）。
- 白名单执法双断言（X15）：子 request/header.tools 只含白名单；孙沿树收窄 = ∩（孙 header 只含
  交集 + 孙直呼白名单外名 → tool-not-allowed isError 配对落账）。
- e2e（默认门加旅程，独立装配不动既有 assembleWorld）：**假适配器脚本按 request.model 分桶**
  （未注册 model 报错不 fallback——防串线）；type 显式 model ≠ 父 model；父调 spawn → 子完成 →
  父第二 turn 消费通知 → 完成；断言两会话 jsonl 落盘（子目录经 spawn 返回的 sessionId 寻址）。

## 5. 语义子集对照结论（提取自 my-agent/DSH 测试）

v1 覆盖：X1/X2/X4(收件箱天然)/X5(stop 级联与可续)/X7/X8/X10/X11/X13(进程内)/X14(净化)/
X15/X17/X19/X20。落档不做：X3(合并 digest)/X6(spawn 中断回滚——工具管线 pre-abort 已挡主要
窗口)/X9(预算)/X16(子→父通道)/X18(信封中和)/X12 的 dispose 失败双通道细节。

## 6. 方案审查处置（A/B 两路并行）

采纳（A）：fork 净化改 surface 重铸（P0——切片破坏 seq 校验与 replace 寻的）；dispose 置
tearing-down 通知门（级联 cancel 不得 steer 复活父，P1）；孤儿子收养处置（get 缺位 → cancel+
dispose+摘行，P1）；occupied/armed 拆分（P2）；父模型从父 options??末次 header 折叠（P3）；
blocked/max-tokens 轮末滞留通知落档（P3）；摘要只取本轮 assistant（P3）；handle 单源 loop.get
（P3）；steer 失败 try/catch（P3）。
采纳（B）：agent_spawn/stop exclusive、message/output/list parallel（P1 超卖窗口）；type.tools
未注册名 spawn 时校验（P1）；无已完成 turn 的 fork 退化为全新子并如实告知（P1）；通知 status
词表对齐全集含 blocked（P2）；e2e 按模型分桶+type 显式异 model+独立装配（P2）；spawn 返回/
视图带 sessionId（P2）；busy 步边界路径用例（P2）；execute 内断信号不遗孤儿（P2）；沿树收窄
双断言（P2）；返回铸文本+反轮询引导（P3）；gate 拒绝配对落账（P3）；undefined=全集（P3）。
落档驳回：无 session 调用方直接拒（而非建无父子——通知无处投）。

## 7. 验收清单

- [x] §1–§4 逐条；四门全绿 + 覆盖率数字如实报告；e2e 旅程绿（提交说明载数字）

## 8. 代码审查处置（A/B 两路并行）

采纳（A）：notifier running 分支复占槽（message 重唤醒的在飞子上限不被旁路——回归用例）；
deliver 兜底 catch（进程级未处理拒绝对不可接受）；viewStatus running 前置（停止复活如实）；
buildChild 入口 tearingDown 查（teardown 期不登记脱管子）；fork system 节点特赦（锚点 replace
漂移后 seq 滤除会丢父系统提示词）。
采纳（B）：busy 步边界真用例（悬停流闸门——turn 数不变 + 后续 step 消化通知）；agent_message
正向路径；子 error turn 通知 status=error 且不回潮前轮摘要；X20 execute 内防线真触达
（toolsExecute 中间件换 signal + 微任务 abort——内存 create 全微任务解析，定时器赶不上窗口）；
并行池三 spawn exclusive 计数不超；fork 含工具轮（tool/result 重铸）；e2e 旅程（分桶适配器 +
双会话 jsonl 落盘 + flush 屏障）；死面清除（reportOf/callerMissing/SpawnPlan/多余导出/as never）；
文档同变三处（状态/件表/验收）。
落档驳回：maxConcurrent 用例的时序耦合注记（已用闸门流稳定化）。
