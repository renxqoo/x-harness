# DESIGN — x-harness Agent SDK（统一中间层）

状态：定稿 v3（审查 A 34 条 + 审查 B 40 条意见全部处置落档）
分级：大级（跨应用架构性抽层，借 repo-migration 方法论文档结构；交付物是新能力层而非行为等价重写——存量行为是不变量基线，SDK 语义叠加其上）

## 0. 目标与背景

apps/host-hub 与 apps/cli 各自实现了一套「控制 agent」的面：host-hub 有线程池、
worker 子进程、帧协议、82 命令词表；cli 有进程内直连 harness 的 REPL。命令语义
（启动/重启/发消息/skill 命令）、事件翻译（session 事件→展示事件）、agent 组装
（插件清单）在两边重复实现且已经漂移。

本设计引入一个统一中间层包 **`@x-harness/agent-sdk`**（`packages/agent-sdk`），
把「线程生命周期管理 + 命令分发 + 事件流翻译 + agent 组装」收拢为一份实现，
四种消费方只挑执行器与传输：

| 消费方 | 执行器 | 传输/入口 |
| --- | --- | --- |
| cli（apps/cli） | in-process | 直接函数调用 |
| 桌面 app | worker（子进程隔离） | 直接函数调用（SDK 内管理子进程） |
| host-hub（apps/host-hub） | worker | stdio JSONL 帧协议（兼容既有客户端） |
| 服务端多住户 | in-process | 直接函数调用，每租户一个 SdkClient |

**用户裁决（已落档）**：
- 服务端多住户不用 worker 子进程——SDK 必须原生支持进程内多实例形态（执行器可插拔的核心依据）。
- 消费方清单：cli、桌面 app、服务端多住户（host-hub 作为既有传输兼容层保留）。
- 流程：先完整方案 → 双子 agent 对抗审方案 → 分阶段实现，每阶段四门 + 双子 agent 对抗审代码、修复回审清零再进下一阶段，直到生产可用收口。

## 1. 问题域

### 处理

1. **词表单一真相**：82 命令闭集 + 派生集合（线程作用域/只读观察/驱动计数/
   live-only/host 转发/parked 直读）只定义一次（sdk/vocab.ts）；删除 host-hub
   `isKnownCommand` 死导出，契约测试断言闭集与派生集合包含关系。
2. **线程生命周期**：start / resume（=「重启 agent」）/ register（仅登记不唤醒）/
   retire（三态）/ stop / park / wake；同 sessionPath 互斥（already_open，含
   retiring/spawning 持有者最长 12s 等待环）；线程数上限、pending 上限、
   `@pending` 槽位预算（worker 执行器私有）。
3. **消息与转向**：send / steer / followup 三入口分别映射 wire 面 prompt+steer+
   follow_up（不折叠，保住 streaming_window 语义）/ abort / clear_queue /
   queue/drop / queue/send_now（entryId 重定向，独立命令）。
4. **命令面**：查询/元数据/操作/skills/plugins/agents/workflow/bash/compact/
   fork/clone/catalog/models/auth/settings/permission（双路由）全量。
5. **事件流**：session 事件 + 平台 ctx token 事件 → 统一 SdkEvent 流，一份翻译
   （下沉 event-bridge），全部消费方共享同一事件词表。
6. **agent 组装**：一份 assembleAgent（hub assembly 为主体，吸收 cli 差异面，
   AD1 全表见 IMPLEMENTATION），目录约定归一为 client 显式注入。
7. **skill 命令**：`/skill` 等斜杠命令走 @x-harness/commands 注册表；send 管道
   保留 hub 语义（`/` 前缀先命令后消息，prompt/compact 两入口同律）。
8. **限额与配额**：全键双执行器同语义；运行时可变；keepalive 豁免 idle 退休；
   idleRetireMs 支持 0=off（cli 交互形态默认关）。
9. **控制面周边**：git/changed 监听、permission 双路由、thread/register、
   catalog/credentials 刷新广播（重读→通知活线程换装）——全部进 SDK。

### 不处理（写清归属）

1. **传输层适配**（stdio/WebSocket/relay 加密）：SDK 发结构化帧；stdio 归
   host-hub 薄壳（IO 喂入/写出），帧构造在 SDK；远程加密归 remote-protocol。
2. **终端渲染**（REPL/颜色/TUI）：归消费方；SDK 事件是结构化数据。
3. **持久化格式**：会话 JSONL 由 @x-harness/session-persistence-jsonl 承载。
4. **租户配额计费**：SDK 提供每 client 独立 limits，租户策略归服务端应用层。
5. **UI 弹窗呈现**：SDK 透传 ui_request 应答管道，呈现归消费方。
6. **远程配对/设备身份**：不进 SDK。
7. **hub-gateway/hub-relay**：不迁（对接面不变；remote vocab 副本收敛挂账）。

## 2. 顶层数据模型

```ts
type SdkResult<T> = { ok: true; value: T } | { ok: false; reason: SdkErrorShape };
```

线程状态机（host-hub thread-table 语义迁入，单一真相）：

```
spawning → live → retiring → (parked | dead | removed)
                  ↘ idle/rss → parked（保留 sessionPath，可 wake）
parked --wake--> spawning → live
fork/clone → rekey：旧 id 消费方视角作废（thread_superseded），新 id 走 thread_rekeyed 事件
```

## 3. 对外契约（API）

包名 `@x-harness/agent-sdk`，入口 `packages/agent-sdk/src/index.ts`。
命名风格：function 工厂 + 判别联合结果 + 事件订阅回调；不抛业务异常。

### 3.1 createSdkClient —— 工厂

```ts
const sdk = createSdkClient({
  mode: "in-process",              // "in-process" | "worker"
  agentDir: "/path/.x-harness",    // 必填：agent 数据根
  sessionsRoot: "/path/sessions",  // 必填：会话 JSONL 根
  env: { ... },                    // per-client 环境快照（缺省 process.env 拷贝，创建时冻结；
                                   //   catalog/limits/script-adapter/凭据 env 解析全走它；多租户必传）
  mailboxRoot: "/path/mailbox",    // 缺省 agentDir 派生，禁止回退 ~/.x-harness（多租户隔离）
  workflowRoot: "/path/workflow",  // 同上
  skillsDirs: ["/path/skills"],    // 缺省按 trusted 规则派生（project+user）
  rgBinDir: "/path/bin",           // 缺省 agentDir/bin
  confirm: async (fields) => ({ allowed: true }),  // confirm/ask 注入（省略则 ui_request 事件兜底）
  limits: { maxThreads: 32, idleRetireMs: 900_000 },  // idleRetireMs: 0 = 关（cli 交互形态默认 0）
  onEvent: (event) => { ... },
  onLog: (message) => { ... },     // 诊断日志出口（SDK 内不直写 stderr）
  spawnOverride: typeof spawnWorker,  // worker 模式注入位（测试/桌面自管进程）
  execPath: { command, args },     // worker 模式子进程入口覆盖（缺省自动解析）
});

await sdk.startup();   // 幂等：建目录/迁移/清理
await sdk.shutdown();  // 幂等：retire 全部线程、结算在途 send、清定时器；总预算 30s
```

- **进程级钩子禁令**：in-process 模式下 SDK 禁止注册任何进程级信号处理器 /
  uncaughtException / process.exit；worker 模式的子进程内不受此限。
- **裸读 env 禁令**：SDK 内禁止裸读 `process.env`，一律走 client 注入的 env 快照。
- **模块级单例禁令**：SDK 内禁止模块级可变状态（lifecycle 串行链/detach pid 表/
  stdout 劫持全部改为 client/执行器实例内闭包；stdout 劫持只在 worker 子进程入口注册）。
- 多实例：同进程多 client 互不共享状态、互不串扰（I9 矩阵逐项断言）。

### 3.2 线程生命周期

```ts
const started = await sdk.startThread({
  cwd: "/repo",                    // 必填
  trusted: true,                   // 项目级 skills/agents 目录加载
  dial: { provider, model },       // 缺省 catalog 默认
  thinkingLevel: "high",
  permissionMode: "auto",          // 缺省 settings 解析链，无设置 auto
  prompt: "…",                     // 可选首条消息（birth 缓冲保证订阅前事件不丢）
  images: [...],                   // ≤8 张/单张 5MB/总量 12MB
  sendId: "my-id",                 // 可选：sendId 由调用方注入（P3 适配器复用帧 id）
  tools: [...], excludeTools: [...],  // 工具限制（cli --tools 语义）
  systemPromptAppend: "...",       // cli --append-system-prompts 语义
});

const resumed = await sdk.resumeThread({ threadId, cwd?, trusted?, dial?, ... });
// parked/dead/未知会话均可（=「重启 agent」）；不可读 → session_unreadable

sdk.registerSession(sessionPath, opts?);  // thread/register：仅登记不唤醒（文件大小/头部校验）
```

句柄（client 的视图，不持有资源）：

```ts
interface SdkThreadHandle {
  readonly threadId: string;
  readonly state: ThreadState;
  readonly info: ThreadInfo;
  readonly events: AsyncIterable<SdkEvent>;   // birth 缓冲 + 有界（见 §3.5）
  on(kind, listener): () => void;
  send(text, options?): Promise<SdkResult<SdkSendReport>>;
  steer(text, options?): Promise<SdkResult<SdkSendReport>>;   // 运行中注入当前回合
  followup(text, options?): Promise<SdkResult<SdkSendReport>>; // 排队下一回合
  abort(cause?): Promise<SdkResult<void>>;   // 异步：bash 准入/运行终止、broker denyAll、
                                             // inflight abortAll、delegation stopAll 全部落地后才 resolve
  command<T>(name, args?): Promise<SdkResult<T>>;
  runCommand(line): Promise<SdkResult<string>>;       // 斜杠命令显式入口
  queueSendNow(entryId): Promise<SdkResult<void>>;    // 队列项重定向（≠steer）
  retire(): Promise<SdkResult<void>>;  // ok | state_conflict（未持久化）| thread_not_live（在途）
  stop(): Promise<void>;
}
```

**rekey 契约**：fork/clone 后线程换 id，SDK 发 `thread_rekeyed{oldThreadId}`；
旧句柄后续调用返回 `thread_superseded`，消费方以新 id 重建句柄（sdk.threadOf）。

### 3.3 消息与等待语义（「发送消息等待」）

- **三入口不折叠**（审查 A#28）：`send`=空闲时 prompt（运行中默认排队）；
  `steer`=运行中注入当前回合（wire steer 语义）；`followup`=显式排队。运行中
  线程直接 `send` 且无排队语义可用时保留 `streaming_window` 错误码路径。
- **sendId 注入**（审查 A#13）：sendId 缺省 SDK 铸造、可由调用方注入；P3 适配器
  复用 wire 帧 id，消除双名空间。settled 的 sendId 与之一一对应。
- **排队 send 归属回合**（审查 A#13）：排队 send 绑定触发其回合的 turn/start
  seq，各自结算自己的回合（不与前一回合的 idle 混算）。
- **abort 异步语义**（审查 A#27）：`abort()` 返回的 Promise 在取消链全部落地
  （工具终止/弹窗拒绝/inflight 清空）后 resolve；settled(ok=false) 在其后必达。
- **每线程并发 driving send 上限**：不发明新值——沿用现状 drivingIds 仅记账
  无上限（审查 A#29），pendingCommandsCap 兜底总量。
- **慢消费背压**：events 面为 birth 环形缓冲（4096，溢出丢最旧）；on 面直通
  无缓冲。分级丢弃与终态保护挂 P2 事件面收尾批。
- **shutdown 兜底**（审查 A#17）：shutdown 时对全部未决 sendId 由 client 合成
  settled(ok=false, reason="shutdown")——worker 可能先退而帧未写出，client 是
  唯一兜底点。

### 3.4 错误码（封闭词表，单一真相）

SDK 错误码 = hub HUB_ERROR_CODES 全集 26 项单源迁移（契约测试断言
SDK 导出 == 文档 == 26 项）：

`unknown_thread | thread_superseded | thread_not_live | session_unreadable |
already_open | thread_limit | streaming_window | invalid_input | unknown_command |
capability_thinking | capability_images | capability_plugin | images_too_many |
model_unavailable | cursor_stale | state_conflict | name_conflict | trust_required |
path_forbidden | io_failed | internal | bash_denied | protocol | compact_rejected |
plugin_install_failed | plugin_uninstall_failed`

会话不可读 → `session_unreadable`；retire 未持久化 → `state_conflict`；
retire 在途 → `thread_not_live`。消息中性英文，消费方本地化。

### 3.5 事件流（SdkEvent）

一份翻译（下沉 event-bridge），词表封闭 12 kind：

```ts
type SdkEvent =
  | { kind: "stream"; threadId; owner; turn; step; agentName?; frame: AssistantStreamFrame }  // 原帧透传（phase start/chunk/end，end.kind=message|attempt）；owner/turn/step 与 wire payload 整体同构
  | { kind: "tool_stream"; threadId; owner; callId; agentName?; delta }      // 同上：owner 区分子代理并发流
  | { kind: "tool_result"; threadId; callId; summary; ok }
  | { kind: "settled"; threadId; sendId; ok; reason? }
  | { kind: "platform"; threadId; name; payload; agentName? }   // 平台 ctx token 事件无损透传
  | { kind: "session"; threadId; event: SessionEvent }           // 原始会话事件（含 surfaceOp）
  | { kind: "ui_request"; threadId; requestId; method; payload; respond(data) }
  | { kind: "thread_state"; threadId; from; to; cause }
  | { kind: "thread_rekeyed"; threadId; oldThreadId }
  | { kind: "heartbeat"; threadId; idleMs; streaming; rssBytes }
  | { kind: "git_changed"; threadId; cwd; branch? }
  | { kind: "error"; threadId?; code; message };
```

关键裁决：
- **stream/tool_stream 保留原帧 + owner 归属**（审查 A#1/复核#1）：AssistantStreamFrame
  直接 re-export @x-harness/agent-loop 原判别联合（phase start/chunk/end，end.kind=
  message|attempt——cli 渲染依赖）；stream 事件携带 owner/turn/step/agentName，与
  wire payload {session,turn,step,frame} 整体同构，P3 适配器可字节级还原。
  tool_stream 的 wire payload {session,callId,delta} 由现有字段承载。
- **send 排队判定边界**（审查 A#28/复核#4）：SDK send 的排队语义只在 SDK 面
  （函数调用）成立；wire 面 prompt 帧不带 streamingBehavior 且运行中必报
  streaming_window（现状不变）。P3 适配器规则：帧入口收到运行中 prompt 帧
  → 原样返回 streaming_window 错误（不代理排队）；SDK 面 send → 适配器用
  follow_up 帧实现排队。两入口各归各，I16 不断言 SDK send 排队与 wire 排队等价。
- **platform 无损透传**（审查 A#12/B#32）：agent/status、agent/error、
  agent_spawned/finished（含 agentName 子代理归属）、compaction_*、autocompact_*
  （7 种）、permission/decided、checkpoint/diagnostic、llm/chunk、
  bash_execution_update——name=token 字面量、payload 与现有 wire 字节同构。
  新增平台事件自动落 platform，无需改 SDK 词表；platform 不享受稳定性承诺（§8）。
- **emitInternalSettled 裁决**（审查 A#14）：worker 帧流里 sendId="" 的内部
  settled 帧**保留**（in-process 执行器同律：线程回到 idle 且无 pending send 时
  发 settled{sendId:""}）——它是「回合彻底结束」信号，与 per-sendId settled
  并存，P3 适配器原样还原。
- **settled 兜底唯一性**：线程终结（dead/park/异常/shutdown）时由 client 对
  未决 sendId 合成 settled，恰好一次的保证以 client 为唯一裁判。
- **events 缓冲契约**（审查 A#26，实现化后对齐）：句柄 events 是 birth
  环形缓冲（容量 4096 硬编码，订阅前事件不丢、溢出丢最旧）；`for await`
  提前 break 即释放（迭代器 return()）；resumeThread 后事件「仅向后」
  （历史走 get_entries）；client.onEvent/thread.on 直通无缓冲——events 面
  慢消费丢最旧、on 面不丢，两面观察可能分叉（已知边界）。eventQueueCapacity
  消费 + 按 kind 分级丢弃 + 终态保护挂 P2 事件面收尾批。
- 心跳双形态：client 级心跳（含 cpuPercent，worker 壳还原 host 心跳字节）与
  线程级心跳（idleMs/streaming/rssBytes）；in-process 的 cpuPercent 无意义不报。

### 3.6 命令面（command()）

线程级命令 = THREAD_SCOPED + HOST_RELAYED 派生集合（作用域表以 internal.ts
四集合为源，契约测试断言 API 文档表 == 派生集合）；client 级：

```ts
sdk.listThreads(); sdk.listSavedSessions(); sdk.registerSession(...); sdk.deleteSession(...);
sdk.threadOf(threadId);                       // rekey 后重建句柄
sdk.limits.setIdleRetireMs(ms); sdk.limits.setRssRetireBytes(n);
sdk.admin.skills/plugins/models/auth/settings/agents/permission.*;
sdk.exportSession(threadId, path);            // cli /export 原语（审查 A#4）
```

**permission 双路由**：无 threadId 或 parked/dead → admin 直读（会话 WAL + 设置
回溯）；live → 透传线程；两路同构结果。

### 3.7 使用示例（完整旅程）

```ts
const sdk = createSdkClient({ mode: "in-process", agentDir, sessionsRoot,
  limits: { idleRetireMs: 0 }, onEvent: (e) => console.log(e.kind) });
await sdk.startup();
const t = await sdk.startThread({ cwd: "/repo", dial, trusted: true });
if (!t.ok) throw new Error(t.reason.message);
const th = t.value;
const report = await th.send("你好", { sendId: "q1" });   // 等待 settled
for await (const ev of th.events) { if (ev.kind === "stream") render(ev.frame); }
await th.command("compact");
const r = await th.retire();    // 三态
await sdk.shutdown();
```

### 3.8 与既有帧协议的关系

host-hub stdio 帧协议（response/event/ui_request/heartbeat×2/thread_died/
thread_parked/hub_error/hello）是 SDK 事件/结果的**序列化形态之一**：薄壳 =
SdkClient(worker 模式) + 帧序列化适配器。字节兼容承诺锚定六处敏感点（审查 A#16/复核#6）：responseLine 键序与 id 双形态、
frame-classify/SETTLED_HEAD 字节前缀正则、eventFrame agentName 尾置、
uiRequestFrame payload 摊平、心跳双形态键序、sessionPayload 键序（seq,time,
…data,session 后置、surfaceOp 尾置）——P0 交付帧字节快照测试逐字节锁定，
frames.ts 与两个正则同居一文件。

## 4. 内部架构

```
packages/agent-sdk/src/
  index.ts              # 公共出口
  client.ts             # SdkClient：生命周期编排、线程表路由、订阅分发、settled 兜底
  catalog.ts            # catalog+credentials 快照（K9）：读 agentDir、reload 广播
  executor-inprocess/   # in-process 执行器（目录名避开 worker/，不命中覆盖率排除 glob）
    run.ts assembly-ref.ts
  executor-worker/      # worker 执行器
    spawn.ts relay.ts pool-mechanisms.ts
  worker-entry.ts       # 子进程入口（stdout 劫持/信号处理只在此注册）
  thread-table.ts events.ts limits.ts errors.ts vocab.ts frames.ts
  git-watch.ts sweep.ts dialog-broker.ts
  commands/             # 命令处理器（respond 目标抽象，双宿主）
    lifecycle.ts send.ts query.ts meta.ts bash.ts skills.ts plugins.ts workflow.ts
    admin/{settings,skills,plugins,agents,models,permission}.ts
  assembly.ts           # agent 组装（AD1 全差异面）
```

依赖方向：agent-sdk → harness/session/agent-loop/…（既有 packages），无反向依赖。

关键决策：
- **K1 执行器接口**：`Executor { start(spec): ExecSession }`——两执行器吐同一
  ExecEvent 流；命令处理器是纯函数（输入→结果+控制事实），双宿主复用。
- **K2 线程表单一真相**：状态机/互斥/上限裁决全在 client。
- **K3 stdout 互斥**：stdout 劫持只在 worker-entry（子进程内）；in-process 全走
  onEvent/onLog 回调。
- **K4 host-hub 薄壳化**：帧构造在 SDK，薄壳只做 IO。
- **K5 零兼容层**：旧实现切换即删。
- **K6 in-process 故障边界**：每线程驱动链 catch-all → dead + 债务结算
  （pending 失败、driving 补 settled、等待者拒绝）+ error 事件，不外溢宿主。
- **K7 in-process 退休判据**：idle 同律（0=off）；rss 改 client 级判据（进程 RSS
  超阈 → 按 idle 序退休最旧）；stale 无进程死概念，in-process 为 no-op
  （心跳同事件循环恒新鲜）。
- **K8 telemetry 单连接**：client 级共享 SQLite 连接注入各 world。
- **K9 catalog 活快照**：client 持快照（per-client env + agentDir 读盘）；
  reload → 重读 → 通知活线程换装；已知限制明文：reload 只增不换，apiKey/baseUrl
  变更需 retire 后生效。
- **K10 模块级单例清零**（审查 A#2）：lifecycle 串行链 per-runtime、detach pid
  表 per-client、stdout 劫持只在 worker-entry；契约测试 grep 断言 src/ 内无
  `process.stdout.write|process.stderr.write|process.on\(|process.exit`（worker-entry
  与 frames 字节快照测试装置除外）。
- **K11 帧字节锁定**（审查 A#16）：P0 交付帧样本快照测试（现存帧字节逐字节
  断言），迁移过程中任何序列化改动先红测试再改实现。

**pool 机制 × 归属矩阵**（审查 A#8）：

| 机制 | client | executor-worker | executor-inprocess |
| --- | --- | --- | --- |
| 状态机/already_open 互斥/12s 等待环/上限裁决 | ✔ | — | — |
| @pending 槽 + rebind + byThread | — | ✔ | 无需（threadId 先 mint 可知） |
| hello 握手 + spawnDeadline | — | ✔ | 同构启动确认信号（组装完成） |
| wake 12 次重试 + resumeWaiter | ✔（重试编排） | ✔（等待器接线） | ✔（直接重试组装） |
| releaseSlotDebts 债务结算 | ✔（唯一兜底） | ✔（进程死触发） | ✔（K6 故障触发） |
| requeue（retiring 窗口命令） | ✔（retiring 判定） | ✔ | ✔（等价：retiring 期间排队） |
| queryLiveWorkers fan-out+timeout | ✔ | ✔ | Promise.race + 同 timeoutMs |
| killStale（SIGKILL） | — | ✔ | no-op（K7） |
| sweep（idle/rss） | ✔ | ✔ | ✔（rss 改 client 级） |

## 5. 测试与验收（口径）

- 契约级：错误码 26 封闭、事件 12 kind 封闭、platform 透传 name 清单钉住、
  命令作用域 == 派生集合、状态机迁移表驱动（含 rekey）、settled 恰好一次
  （client 兜底唯一裁判）、already_open、resume 唤醒 parked/dead、retire 三态、
  **帧字节快照**（K11，六处敏感点）。
- 并发：同 sessionPath 竞态、wake 重入、shutdown 与在途 send、abort 后 settled
  必达、多 client 隔离矩阵（I9：目录/env/事件流/telemetry）、背压溢出、
  K6 故障注入。
- 回归：host-hub/cli 既有 __test__ 语义迁移（MIGRATION 矩阵逐文件）。
- e2e：sdk-journey（in-process 全旅程，假 LLM）+ host-hub stdio 帧回归
  （落 host-hub 薄壳 __test__，沿用真进程夹具形态）+ 双形态冒烟。
- 覆盖率：agent-sdk ≥ 90/85，不新增排除；worker 侧文件覆盖策略 = in-proc
  harness（input/writerOverride 注入）+ spawnOverride（公共测试位）。

## 6. 并发与性能预算

- 事件回调同步耗时 < 1ms；流增量节流 25ms。
- in-process：每线程一个 World；定时器每 client 2 个（sweep + 心跳探针）。
- worker：spawn 超时 10s、resume 重试 12 次、pendingCommands 65_536、requeue
  1024 条/4MB（溢出发 error 事件）、shutdown 总预算 30s。
- in-process shutdown：每 world 销毁链超时 10s、总预算 30s、部分失败不阻断。
- 背压：有界队列 1024；confirm 超时可配（缺省 300s）；迟到 respond 是 no-op。

## 7. 已裁决分叉（含双审合并）

- Q1（用户裁决）：cli 随本次切换（P4）。
- Q2：send 排队语义双执行器一致（inbox 单源）；三入口不折叠（A#28）。
- Q3：spawnOverride/execPath/input/writerOverride 全部暴露为公共测试位（A#23）。
- Q4：hub-gateway/hub-relay 不迁；remote vocab 副本挂账。
- Q5：SDK 新路径不命中覆盖率排除 glob；目录命名避开 worker/（A#22）。
- Q6：审查 B 40 条处置（词表全集/控制面周边归属/env 注入/进程钩子禁令/
  K6-K9/providers 迁移/cli 行为变化清单/版本演进 §8）。
- Q7：审查 A 34 条处置（stream 保留原帧/platform 无损+emitInternalSettled 保留/
  sendId 注入+排队归属回合/abort 异步/模块单例清零 K10/帧字节锁定 K11/
  pool 归属矩阵/idleRetire 0=off/queryLiveWorkers in-process 对应/P1 respond
  抽象先行验证/kit 夹具归属/stdio 回归落点/AD1 补六行/slash 依赖对照表/
  driving 上限删发明值）。

## 8. 版本与演进

- SDK 包 semver；帧 protocolVersion 只随 major 递增。
- 命令词表只增不删（删除走 major）；未知命令永远 unknown_command。
- SdkEvent kind 同律；platform 透传不享受稳定性承诺（name=平台 token 透传，
  消费方按白名单取舍）。
- 字节兼容承诺范围：response/event/ui_request/heartbeat×2/thread_died/
  thread_parked/hub_error 七种帧字段与序列化（K11 快照锁定）。
