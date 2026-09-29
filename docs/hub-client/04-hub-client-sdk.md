# 04 · SDK 本体 `@x-harness/hub-client`

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；契约：[03](03-hub-protocol.md)；观测细节：[05](05-observability.md)

## 1. 文件架构（一一动词一文件）

```
packages/hub-client/src/
  index.ts              出口（connectHub/createHubPool/类型）
  ids.ts                呼叫 id 铸造（单调序唯一/保留前缀守卫）
  events.ts             事件总线（on/off/分发保序/快照迭代/回调异常隔离）
  stats.ts              观测计数器（单一可变快照，只读拷贝导出）
  core.ts               会话核心：pending 表/超时/对账/行超限本地拒/发送队列上界/exit 结算（传输无关）
  transport.ts          传输抽象面：send/onLine/closed/kill（纯接口）
  process.ts            process 传输实现：spawn + JSONL 泵（链式缓冲）+ 背压 drain
  heartbeat-supervisor.ts  心跳死线监督（1s 检查 + 未读积压防护 + close/kill 悬挂）
  resolve-host.ts       hostBin 解析序（显式 → 仓库源入口 → dist 产物 → 装置相对路径 → 拒启）
  connect.ts            connectHub 装配（ready 判定/exit 结算/观测缝接线）
  command-types.ts      CommandResponses 映射（D9，见 05 §5）
  pool.ts               createHubPool（见 06）
  __test__/             单元（假传输/假时钟）+ 契约（真 host 进程，script 假 worker）
  testing/              kit 装置 + createTestHub/createTestPool 测试缝导出面（startHost/drivePrompt/spawn/now/timer/existsSync；供 host-hub dogfood 与本包测试共用；08 §2）
```

依赖纪律（可机械检查）：

- core/events/stats/ids/command-types **零 node 进程 API**（假传输全单测的前提）；
- process 是唯一 `node:child_process` 触点（I3 的落点）；
- pool 只依赖 connect 返回的 Hub 接口（可注入假工厂全单测）；
- resolve-host 是唯一 `node:fs`/`node:path` 触点（测试可注入 existsSync）。

## 2. 连接生命周期 API

```ts
import { connectHub, createHubPool } from "@x-harness/hub-client";

const hub = await connectHub({
  hostBin?: string,               // 缺省解析序见 resolve-host.ts
  agentDir?: string,              // 缺省 ~/.x-harness/hub（与 host cli.ts:6 同源语义）
  sessionsRoot?: string,          // 缺省 <agentDir>/sessions
  env?: Record<string, string | undefined>,   // 追加覆盖；**合并序与防线见 §3 env 条**（危险键拦截）
  heartbeatDeadlineMs?: number,   // 缺省 15_000（host 心跳 1Hz；gateway 用 10s，SDK 取宽档——消费端可收紧）
  callTimeoutMs?: number,         // 缺省 60_000（从进入 call 起算，含背压排队时间）
  killTimeoutMs?: number,         // kill() 宽限缺省 = HOST_SHUTDOWN_BUDGET_CEILING + 5_000（=45_000；CEILING 是 hub-protocol 导出的收编预算契约常量，03 §1 line-limit——改一处两端测试红，C8 门禁）
  closeTimeoutMs?: number,        // close() 宽限同源派生（同上），超时升级 kill（§4-3）
  maxSendQueueBytes?: number,     // 发送排队字节上界，缺省 64MiB（02 B3'；超限新 call 本地拒）
  log?: (level, message, fields?) => void,    // 缺省 noop（05 §3）
  onRawLine?: (line, dir: "in" | "out") => void,  // 缺省无
  onHandlerError?: (error: unknown, kind: string) => void,  // 缺省 stderr 一行
  // 测试缝（spawn/now/timer/existsSync）不进公共参数面——经 @x-harness/hub-client/testing
  // 子出口的 createTestHub 暴露（内部展开为 connectHub 的内部构造面）；公共签名保持消费端最小面
  // （无 onSettled 公共/内部缝——池计活由 pool 的 bindHub 包装层实现：包装 call 计活，零 connectHub 改动；06 §1 单源）
```

**ready 判定**：首帧心跳到达才 resolve（host 心跳 1Hz 先于慢速装配，启动窗口有覆盖；
与 kit/host-client.ts:139 现行为同构）。reject 面（唯一）：spawn 失败 / 死线内无心跳 /
**ready 前进程退出**（exited 先到 → 立即 reject，不等死线）/**危险 env 键**
（消费端 env 带五禁键 → 构造期 reject，message 列冲突键——§3 env 条）。此时无已发呼叫、无泄漏
——spawn 失败即无进程；无心跳则 kill 收割后 reject。

**句柄面**：

```ts
hub.call<K extends keyof CommandResponses & string>(
  command: K, args?: CommandArgs[K], opts?: { timeoutMs?: number; signal?: AbortSignal },  // id 不对外：无消费端动机（sendId 配对用 SDK 铸造 id 原样回传）——自定义 id 及其配套复杂度已删（D12 裁决：不背无用户的特性）
): Promise<HostResponse & { data?: CommandResponses[K] }>;

hub.on("event", fn: (e: HostEvent) => void): void;              // 全事件
hub.on("event", "settled", fn: (e: HostEvent) => void): void;   // 事件名过滤重载
hub.on("ui_request" | "heartbeat" | "hub_error" | "thread_died" | "thread_parked", fn): void;
hub.on("exit", fn: (info: ExitInfo) => void): void;
hub.off(kind, fn): void;                   // 与 on 对称：过滤注册的注销也带过滤参数
hub.off("event", "settled", fn): void;    // 三参 off——与三参 on 一一对应（否则无法区分同名 fn 的两种注册）
hub.stats(): HubStats;             // 05 §2（只读快照拷贝）
hub.exited: Promise<ExitInfo>;     // { code; reason: "closed"|"heartbeat-deadline"|"killed"|"exited"; inflightSendIds: string[] } —— 结算前快照的当轮在飞 sendId（06 §3 消费端清配对表用；exit 三步先结算后发事件，故必须结算前快照）
hub.close(): Promise<void>;        // §4-3
hub.kill(): Promise<void>;         // §4-4
```

`call` 的 command 参数类型：已标注命令走窄重载（`K extends keyof CommandResponses
& string`——args/data 类型联动）；未标注命令走词表重载（`command: Exclude<CommandName,
keyof CommandResponses>`——hub-protocol 的 CommandName 联合，**词表内拼写错误
编译期拦截**（`call("thread/lst")` 红线，zero runtime cost）；词表外字符串被类型
拒绝（消费端不可绕过词表——新命令未及入词表的窗口不存在：词表与 host 同提交
更新，03 §6 登记流程）。运行期 host 闸门（unknown_command）仍是最后防线。

## 3. call 语义细则

- **id 铸造**（ids.ts）：id 仅 SDK 铸造 `c<单调序>`（连接内唯一且**永不复用**——无自定义 id 参数，无环形上界/逐出 apparatus，04 §2/D12 裁决已删）；铸造器永不产出 `@hub-internal:` 前缀（host 侧 worker-pool.ts:381 对该前缀拒绝）；另避让 `@pending-`（worker-pool.ts:295 的 threadId 槽位内联字面量，非 id 闸门——避让是防御性卫生非协议要求）；
- **序列化与行上限**：JSON.stringify 后超 CLIENT_LINE_LIMIT（16MiB）→ 本地合成
  failure（protocol, "line exceeds limit"），**不写管道**——host 侧对超限行只发无 id
  parse failure（host.ts:182-186），本地拒绝对账完整（有 id 可结算）；
- **对账**（core.ts）：response 帧按 id 恰结算一次（resolve/reject 均算——本 SDK 全
  resolve，reject 面只在 connectHub）；重复 id 响应（不可能来自正常 host；垃圾输入
  防御）→ 丢弃+计数 lateResponses；超时结算后晚到响应丢弃 + 计数；`success:false` 且
  isHubErrorShape(error) 为假（垃圾形状）→ 按协议失败结算（不吞、计数
  malformedFailures）；
- **无 id response**（host parse failure 形态）：不结算任何 pending；计入
  stats().protocolFailures（host 侧坏命令事实，消费端可观测）；
- **传输失败合成**（进程退出/心跳死线/超时/写失败/已 close）：
  `{ type:"response", id, command, success:false, error:{ code:"protocol", message:"hub-client: <事实>" } }`
  （02 §8 错误哲学）；command 取呼叫时登记值（pending 表持有）；
- **env 合并序与危险键防线**：最终 env = `{...process.env(选取), ...消费端 env, ...SDK
  注入(HUB_AGENT_DIR/HUB_SESSIONS_ROOT 由 agentDir/sessionsRoot 参数派生)}`——**SDK
  注入最后落，不可被消费端 env 覆盖**（覆盖序写错即击穿每用户隔离）；**危险键
  拦截**：消费端 env 含 HUB_WORKER_PROVIDER/HUB_WORKER_SCRIPT/HUB_WORKER_DISPATCHED/
  HUB_AGENT_DIR/HUB_SESSIONS_ROOT 时 SDK 拒启（合成错误结果，message 列出冲突键）
  ——这五键是测试装置能力（script 假 worker）与 SDK 自管键，从生产 env 面上
  移除；测试装置经 src/testing 子出口内部注入（不经公开 env 参数）；其余
  HUB_* 旋钮（HUB_MAX_THREADS 等容量类）允许透传；
- **per-call 取消面**：`opts.signal?: AbortSignal`——abort 触发即结算（合成
  failure, protocol, "aborted"），行为等价超时（晚到响应丢弃+计数）；不向 host
  发任何命令（host 无取消语义——消费端要停 turn 用 abort 命令，二者语义不同
  显式区分）；
- **背压与写路径**：**先登记 pending（含超时定时器）再写管道**——保证死线/kill/
  close 收割时在飞呼叫必被结算（U2 语义完整性）。stdin write 返回 false →
  await drain；**drain 与退出/错误/收割竞争**：Promise.race([drain, exited,
  error])——流天/管道断时 drain 永不到来，由退出/错误侧结算，不留悬挂 promise
  与监听器。写失败（含异步 EPIPE——同步 try/catch 包不到）走传输失败路径：
  transport 实现必须挂 stdin 'error' 监听（不挂则是 unhandled 'error' event
  崩溃消费进程；对照 host 侧先例 worker-process.ts:41），error 事件转送失败结算。
  超时从进入 call 起算（含背压排队时间）——排队即计时，避免 drain 挂起吃掉全部
  超时预算还不结算；

## 4. 事件与副作用时序（一次性事件恰好一次）

1. **分发保序**：事件回调在帧到达序内同步调用（单 stdout 泵、全序）；回调抛错进
   onHandlerError，不中断分发、不影响 pending 结算（events.ts 异常隔离）；
   **分发中变更监听集**：快照迭代——分发开始时快照监听器列表，回调内 off() 对
   后续帧生效（本次已快照不受影响），回调内 on() 同理；off-during-dispatch 进
   单元向量（07 §2）；
2. **exit 三步**（固定次序、恰好一次）：全部 pending 立即合成 failure 结算 → `exit`
   事件 → exited resolve。**触发锚点 = stdout 流关闭（'close'，含 EOF 排空）**，
   不是子进程 'exit'——SIGCHLD reap 与管道残留 'data' 分发无顺序保证，锚定
   'exit' 会把已在管道里的真实响应误合成 failure（对照：host 自己收 worker 就锚
   stdout 'close'，`worker-process.ts:73`，'exit' 仅 5s 兜底）；进程 'exit' 作
   stdout 不关的异常形态兜底；双源 once-guard 合并，reason 按先到者；
3. **close()**：stdin.end() → host EOF 优雅停机（host.ts:212：worker 收编、末帧冲刷、
   exit 0）→ stdout 排空 + 进程退出 → exit 事件 → resolve。幂等（重复调用返回同一
   promise）。**close 发起时同步悬挂心跳死线监督**（host 停机期 clearInterval 心跳
   且 shutdownAll 静默可达 30s+，不悬挂则死线把优雅关闭变 SIGKILL）。**close 宽限**：
   closeTimeoutMs（缺省 45s，覆盖 host shutdownAll 总预算 30s + 余量）超时未退出 →
   自动升级 kill 收割（reason 仍 closed）。close 后 call() → 合成 failure
   （protocol, "shutting down"——与 host 侧同语义，本地先行）；
4. **kill()**：幂等（重复/与 close 并发 → 同一收割 promise，先发起者定 reason）。
   SIGTERM（host 的 shutdown 处理器收 worker，host.ts:171）→ killTimeoutMs 宽限 →
   SIGKILL 兜底，宽限定时器在进程退出时即清（不残留）。**缺省 killTimeoutMs =
   45s**：host shutdownAll 节奏 = worker eof 后 workerExitTimeoutMs(10s) 才发首发
   worker SIGTERM、再 2s SIGKILL、总预算 30s（worker-pool.ts:500-511）——短宽限
   会在 host 发出 worker SIGTERM 前就 SIGKILL host，孤儿化正在慢收编的 worker；
   45s > host 全预算。SIGKILL 后 worker 孤儿风险由 worker 侧 stdin EOF 退出语义
   兜底（worker.ts:219 shutdown("stdin-end")——host 死则管道断，worker 自退），
   契约测试验证无孤儿；
5. **心跳死线**：超 heartbeatDeadlineMs 无**任何 stdout 帧**（不只 heartbeat——host
   忙时帧稀疏，任何帧都证明活着；与 gateway host-attach 现行为对齐：其 lastHeartbeat
   在 stdout data 时刷新；01 §7 术语「心跳死线」口径以此为准——统一为任意帧；
   **分发窗口时钟冻结**：lastFrameAt 取分发开始时刻（到达时刻）而非结束时刻——
   到达才是活性证据，按结束时刻记会把陈旧帧伪装成新鲜、拖死真死线；回调阻塞
   耗时计入静默是正确取舍，误杀防护由确认层 b) 承接）→ 标记失活 → kill 路径
   收割 → exit 三步（reason=heartbeat-deadline）。死线检查定时器 1s 间隔（B1）。
   **误杀防护（双层）**：
   a) **调度抖动层**：死线触发时不立即收割——先非阻塞读一次排空（stream.read()
   有数据 → 数据已到未处理，刷新 lastFrameAt 跳过本轮；覆盖「字节已出内核、
   timers 相位先于 poll 相位」的窗口）；
   b) **确认层**：单次触发不收割，需**连续两轮检查**（隔 1s）均判静默才收割，
   期间任何帧到达/可读即重置——消除「回调阻塞恢复后首轮 timers 先于 poll」的
   调度窗口误杀（B6 消费端回调阻塞场景的代价边界；机制保证：libuv 重复定时器
   每轮迭代至多触发一次，两轮实际执行间必经一次 poll 相位，期间到达的帧照样
   重置）。
   两层均进单元向量：假传输分别预置「缓冲积压」与「回调阻塞恢复后首拍」两种
   形态断言（07 §2）；实施形态注：泵若用 flowing mode（'data' 监听）则内部缓冲
   恒空、a) 退化为空转，防护独由 b) 承接（成立）；paused/read 循环形态 a/b 均有效
   ——测试向量按实际泵形态构造；
6. **stderr**：host stderr 默认转发消费端 stderr（前缀 `[hub-host:<pid>]`——host 侧
   自身日志语义保留）；log 缝可接管。

## 5. 受理-完成二段性（SDK 最重要的语义披露）

host 命令按响应语义分四族（即答/受理/即答长尾/半受理——01 §2.7 事实）：

| 族 | 例 | 第一段 response | 第二段事实 |
|---|---|---|---|
| 即答族 | thread/list、get_host_info、settings/get、get_models、parked 直读族 | 终态（data/error 即结果） | 无 |
| 受理族 | **prompt/steer/follow_up**（驱动；DRIVING_COMMANDS） | 受理（success 只表「已登记/已投递」） | 事件流：settled（sendId 配对，{sendId, ok, reason?}，`event-bridge.ts:275`；sendId=呼叫 id 原样回传） |
| 即答族（长尾） | **bash** | **终态 response**（data 含 output/exitCode/cancelled/truncated，`bash-commands.ts:17-34`；不进 drivingIds、无 settled 第二段） | 事件流仅 `bash_execution_update` 进度（非完成信号） |
| 半受理族 | thread/start、thread/resume | response data 含终态事实（threadId/cwd/sessionPath，`thread-commands.ts:298-302,350-353`）——但 worker 装配是异步的：response 到达时 thread 已登记；prompt 类驱动另走 settled |

**SDK 不折平二段性**（薄而不蠢）：`call("prompt")` resolve 只表受理；完成事实由消费端
`on("event","settled", ...)` 按 sendId 配对消费。settled 事件载荷 `{sendId, ok, reason?}`
（SettledEvent）；worker 死亡时 host 主动合成 settled `{ok:false, reason:"worker-died"}`
（worker-pool.ts:76-80）；另有 sendId 为空串的内部 settled（`event-bridge.ts:99`，resume 历史轮次扫尾——**消费端不得整段丢弃，作「线程有活动但无法归因」的弱信号处理**，口径与 06 §3 一致）。包 README 与 call 的 JSDoc 显式披露此语义（消费端最易踩的坑）。

## 6. transport 抽象面（传输无关核心的接缝）

```ts
// transport.ts（纯接口，零实现）
export interface HubTransport {
  send(line: string): Promise<void>;        // 含背压 drain；drain 与退出/错误竞争（§3 背压条）
  onLine(cb: (line: string) => void): void; // 单订阅（泵在实现内）
  closed(): Promise<{ code: number | null; signal: string | null }>;  // 锚 stdout 'close'（§4-2）；进程 'exit' 作兜底
  kill(graceMs: number): Promise<void>;     // SIGTERM→宽限→SIGKILL；幂等
  stop(): void;                             // 定时器/监听器清理（死线监督 + kill/close 宽限定时器）
}
```

core 持 transport 引用做结算与分发；process.ts 实现（spawn + jsonl 分帧 + 死线监督 +
背压）；未来远程传输新增实现文件，connect.ts 加装配分支（02 §7）。**单订阅是刻意
约束**：多订阅需求由 events.ts 广播解决，传输层保持最小面。

## 7. resolve-host 解析序

1. 显式 `hostBin`（非空字符串）→ 直接用（绝对路径或 PATH 解析，spawn 语义）；
2. 仓库源入口：`<cwd>/apps/host-hub/src/host/cli.ts` 存在 → `process.execPath + [该文件]`
   （对齐 gateway resolveHostBin 现行为 host-attach.ts:22-34）；
3. dist 产物：`<cwd>/apps/host-hub/dist/host/cli.js` 存在 → 同上；
4. 装置相对路径（testing 模块 `import.meta.dirname` 定位，
   `../../../../apps/host-hub/src/host/cli.ts`——src/testing → src → hub-client →
   packages → 仓库根，四级；保住 kit「任意 cwd 可跑」鲁棒性，cwd 探测从子目录
   跑会空翻）；
5. 都没有 → reject（connectHub 唯一 reject 面之一），message 列出探测过的候选。
   装置缺省 entry 走完整解析序：根目录下命中候选 2（src），任意子目录由候选 4 兜底（仍 src）——候选 2 与 4 是同一目标（src 入口）的两条定位路径，候选 3（dist）不进装置缺省组合（spawn 目标不随 dist 存在性漂移）。

测试缝：existsSync 注入经 testing 子出口（createTestHub 内部构造面——与 04 §2 同策，不进公共参数）；kit 装置与「装置缺省 entry」同主体——走完整解析序（src 恒定）。

## 8. 与 gateway host-attach 的差异表（为什么不直接抽它）

| 维度 | gateway host-attach | hub-client | 理由 |
|---|---|---|---|
| 重启 | kill&restart 内建（onRestart 回调） | 无（D3） | 策略归消费端 |
| 对账 | 无（gateway 自建 pendingByHostId 在 host-ingest） | pending 表内建 | SDK 主职责 |
| 事件分发 | 单 onLine 回调给 host-ingest | events 总线 + 名过滤 | 消费端多样 |
| 心跳死线 | 10s 硬编码 | 15s 可注入 | 死线值是部署属性 |
| kill 宽限 | 2s 硬编码 | 45s 可注入（对齐 host 收编预算 §4-4） | 同上 |
| 行超限 | 无处理（缓冲无限增长风险） | 16MiB 分帧 + 本地拒 | B3 预算 |
| 行解析 | 手写 buffer.indexOf 循环 | createJsonlSplitter 单源 | 消灭 gateway 侧镜像（kit 随装置迁移同源化；worker-process 的 128MiB+violation 专属循环与 host-attach 手写循环按 D6 不迁——仓库仍存语义不同的分帧实现，非镜像） |

D6 裁决：gateway 不迁移到 SDK（多设备路由/tier 语义独立），只换 classifyHostLine
导入源——上表是「为什么不」的显式落档，防止后续误扩 scope。
