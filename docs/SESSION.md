# Session 件契约（事件日志 + surface 投影 + 落盘屏障）

> 状态：现行契约（扩展方案见 [SESSION-RESUME.md](./SESSION-RESUME.md)：收件箱词条、header 覆盖、可验证续写）
> 级别：中（新子系统、新外部契约、并发/一致性语义；无存量迁移面）
> 参照：deepseek-harness `packages/core/session`（事件信封判别联合 / surface 投影 replace 原语 / 持久化订阅-排空桥 / seed 边界标记）。“参照”仅取机制思想，不逐件复制——无对应存量约束的机制按本仓现实裁剪（如格式版本字段：本仓无历史档案，不预埋）。

## 1. 契约

### 1.1 包与装配

| 包 | 提供物 |
| --- | --- |
| `@x-harness/session` | 插件 `sessionPlugin`（name: `session`）：provide `sessionStore`/`sessionAuditDrain` 服务；拥有 9 个 token（3 服务 + 6 总线）；导出 `mintSessionId`（时间戳-随机，`create` 缺省铸号单一来源——跨进程唯一） |
| `@x-harness/session-persistence-jsonl` | 插件工厂 `createJsonlSessionPersistence({ root, onIoError? })`（name: `session-persistence-jsonl`，`inject: ["session"]`）：provide `sessionArchive` 服务，订阅总线完成落盘 |

```ts
const ctx = createContext();
await loadPlugins(ctx, [sessionPlugin, createJsonlSessionPersistence({ root: dir })]);
const store = ctx.use(sessionStore);
```

宿主若要让 plugin-manager 动态安装的 worker 插件观察到会话事件，须把 emit token 经 `createPluginManager({ tokens: [sessionCreated, sessionEvent, sessionAuditEvent, sessionDisposed] })` 注册进可桥接表（内核按 token 对象身份注册，同名不同对象互不可见；worker 桥仅放行 emit 监听）。

### 1.2 总线 token（session 件拥有，封闭词表，共 6 个）

| token | 模式 | 载荷 | freeze | 时序 |
| --- | --- | --- | --- | --- |
| `sessionCreateGuard` | guard | `{ header }` | — | **每条诞生路径**（create 与 fork）落账前派发；任一 deny → 会话不诞生（零残留） |
| `sessionCreated` | emit | `{ header }` | none（构造期预冻） | 诞生路径全部落账后广播，恰好一次；fork 产生的子会话同样广播（header 含 `parentSession`） |
| `sessionEvent` | emit | `{ session: SessionId; event }` | none（构造期预冻） | 每次**活回路 append** 成功后同步广播（**UI 观察面**——仅宿主渲染消费，禁止任务处理；红线为纪律约束，非类型/测试执法）；构造期事件（seed 前缀 + end-seed）不逐条广播，经 created 首灌覆盖（§1.8） |
| `sessionAuditEvent` | emit | `{ session: SessionId; event }` | none（构造期预冻） | 与 sessionEvent 同载荷的**审计面**：微任务级异步投递（queueMicrotask，FIFO 保序、不丢不重）——任务处理消费者（持久化/checkpoint/计量/压缩状态/第三方 tap）专用。投递时序为协议约束：桥接 onFlush 先同步排空本通道再派发 sessionFlush（结构性保证，不依赖监听器注册序）；禁 setTimeout/setImmediate 调度（换宏任务即破坏全部屏障时序——微任务与 promise reaction 同 FIFO 是 V8/JSC 运行时事实） |
| `sessionFlush` | parallel | `{ session: SessionId }` | — | store.flush 派发；all-settled，聚合错误经 flush 的 Result 上浮 |
| `sessionDisposed` | emit | `{ session: SessionId }` | none | store.dispose 移除后广播，恰好一次 |

### 1.3 事件信封与词表（闭合，17 词条）

```ts
type SessionEvent = { type; seq; time; data }
  & (type ∈ SurfaceEventType ? { surfaceOp: SurfaceOp } : { surfaceOp?: never })
```

- `seq` 单调连续，由 Session 独占分配（= 落账时日志长度）；`time` 为 Unix 毫秒。**物化先行**：append/seed/header 一律先 `materializeJson`（单一 JSON 值域权威——稀疏数组/原型污染/Symbol 键/显式 undefined/非有限数与 -0 全拒；getter 单遍定影，门与存储不可能见到不同值），门只看快照形状，快照深冻入账——调用方对象永不被就地冻结。
- **surface 词条**（产模型可见消息，仅此 4 类可携带 surfaceOp）：`system/message`、`user/message`、`assistant/message`、`tool/result`。
- **log-only 词条**：`turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/attempt`、`tool/call`、`request/header`、`request/context`、`llm/retry`、`session/end-seed`、`autocompact/checkpoint`、`todo/snapshot`。

| 词条 | data 形状 | 事实 |
| --- | --- | --- |
| `turn/start` | `{ turn }` | 开 turn |
| `turn/end` | `{ turn; reason: TurnEndReason }` | 关 turn；`interrupted` 变体仅由 resume 消费方补写，活回路不产 |
| `step/start` / `step/end` | `{ turn; step }` | 步括号 |
| `system/message` | `{ turn; step; text }` | 模型可见 system 消息（普通 surface 节点，无特判） |
| `user/message` | `{ turn; step; content: ContentBlock[] }` | 模型可见 user 消息 |
| `assistant/message` | `{ turn; step; content: ContentBlock[]; usage?; stopReason?; interrupted? }` | 消息即账本：输出与用量同行 |
| `assistant/attempt` | `{ turn; step; error; usage? }` | 未沉淀为消息的失败尝试（观测用，不进消息面）；中断前已收到的 usage 帧随尝试落账（token-meter 失败尝试计费） |
| `tool/call` | `{ turn; step; callId; name; arguments }` | 模型发起的工具调用（arguments 为未解析原串） |
| `tool/result` | `{ turn; step; callId; content; isError? }` | 工具结果，按 callId 关联 |
| `request/header` | `{ model; provider?; temperature?; maxTokens?; tools: ToolRef[] }` | 请求信封快照（拨号配置 + 工具表） |
| `request/context` | `{ provider; model; contextWindow? }` | 线路能力元数据（容量等）；不参与请求重建；何时写入归写方策略 |
| `llm/retry` | `{ turn; step; provider; retry; delayMs; failure{message, code?} }` | 重试调度审计（docs/LLM-RETRY.md）：先于等待落账；预算为进程内计数，事件是观测面 |
| `session/end-seed` | `{ inherited?: true }` | seed 边界：之前的事件来自 seed；**构造器唯一合法写者**。**消费方以日志中最后一个 end-seed 为当前边界**（审查处置 P5）；前缀中的祖先标记是历史事实，保留不删——fork 逐字复制前缀必然携带祖先标记，属合法日志 |
| `agent/inbox/spliced` | `insert{target,entries} \| claim{target,turn,claimed} \| clear{reason}` | 收件箱拼接（log-only）。fold 投影归 agent-loop；**claim 按成员移除（携带被领条目 id 全集）**；fold 判重按**当前队列在场**——claim 移除后同 id 再 insert 必须重新入队（repair 回灌依赖，SESSION-RESUME §1.1） |
| `autocompact/checkpoint` | `{ turn; step; ledger; coveredSeq; stale? }` | autocompact 账本快照（log-only，docs/COMPACTION.md §1.2）：ledger 为序列化原文，coveredSeq = 已收编覆盖的 journal seq 边界；重开恢复折叠 last-wins、垃圾跳过 |
| `todo/snapshot` | `{ seq; tasks: TodoSnapshotTaskData[]; edges: [blocker,blocked][] }` | todo 清单全量快照（log-only，docs/TODO.md §13）：每次变更后 last-wins 落账；恢复侧惰性 fold 折尾；id 规范形/无自环无悬空/seq ≥ max(id) 由词条门拒 |

```ts
type TurnEndReason =
  | { kind: "completed" } | { kind: "aborted" } | { kind: "blocked" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "max-tokens" } | { kind: "interrupted" };
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; callId: string; name: string; input: string };
type ToolRef = { name: string; description?: string };
```

### 1.4 surface 投影（replace 原语）

- `SurfaceOp = "append" | { op: "replace"; startSeq; endSeq }`。
- append：节点入投影尾。replace：`startSeq`/`endSeq` **都必须是当前 surface 现存节点**（以 seq 定位），且 startSeq 端点的**位置**不晚于 endSeq 端点；摘除两端点位置之间（含）的全部 surface 节点，新节点落在 startSeq 端点原位置；日志永不改写。
- 区间按**位置**不按数值成员：迭代前缀替换（压缩/滑窗）落地后头部节点携带 journal 尾 seq、其后保留节点 seq 更小，摘除集不再是数值连续区间（docs/COMPACTION.md §2.A）。**对既有档案等价**：此变更前唯一 replace 写者是单点替换 `[seq,seq]`，两种语义对全部已产档案重放恒等。
- 压缩/滑窗/上下文裁剪 = 追加一个带 replace 的摘要事件——策略归消费方插件，本件只提供原语。
- `Session.surface(): readonly SurfaceNode[]`（`{ seq, event }`，消费方取 seq 锚点算区间）；`Session.deriveMessages(): readonly SurfaceMessage[]`（`role: system/user/assistant/tool` 的模型可见消息快照）。两者与 `events()` 同为纯函数派生快照，返回冻结数组。

### 1.5 Store / Session API

```ts
create(options?: { id?: SessionId; seed?: readonly SessionEvent[]; parent?: SessionId; header?: SessionHeader }): Promise<Result<Session>>
fork(source: SessionId, options?: { untilSeq?: number; id?: SessionId }): Promise<Result<Session>>
get(id): Session | undefined
list(): readonly SessionId[]
flush(id): Promise<Result<{ flushed: true }>>
dispose(id): Result<true>
```

- `create`：id 缺省铸 `mintSessionId()`（`<UTC时间戳>-<6位随机>`，跨进程唯一；碰撞为概率级零风险 ~4.6e-10/同秒对，命中仍按 `session-id-reused` 永久拒绝——fail-closed 契约保留，不做 resume 分支重试/再铸号）；显式 id 先过路径安全门（§1.8）。seed 提供 = resume/replay 语义：校验通过后由构造器追加 `session/end-seed`（不带 inherited）；`parent` 回填血缘（resume 消费方从 `archive.read` 的 header.parentSession 取，审查处置 P5）。**`header` 提供 = 归档原文覆盖**（id 取 header.id、parent 忽略、元数据保留；SESSION-RESUME §1.3）。guard deny / id 冲突（含 await guard 后的二次占用检查，并发同显式 id 恰一个成功）/ seed 非法 / invalid-header → `Result` 失败，零残留。
- `fork`：经 `events()` 冻结快照读取源日志（并发 append 不影响一致性），复制 `[0, untilSeq]` 闭区间前缀为 seed（逐字复制，含祖先标记），追加 `session/end-seed { inherited: true }`，子 header 记 `parentSession`；内部走与 create 相同的诞生路径（guard + created 各恰好一次）。`untilSeq` 值域 `0 ≤ untilSeq < len`（空前缀非法，`-1`/`len` 越界失败，审查处置 P9）；源不存在 → 失败。
- `flush`：未知 id → 失败；派发 `sessionFlush` 屏障，聚合错误 → 失败。**空屏障语义**：未装配（或已卸载）持久化插件时 flush 立即成功——成功 = 屏障完成，不承诺字节落盘；需要落盘保证的宿主必须装配持久化插件（审查处置 P8）。
- `dispose`：移除、**封存 Session 写权**（此后该 Session 的 append 返回 `session-disposed` 失败；`events()/surface()/deriveMessages()` 读面仍开放——历史可查，审查处置 P4）、广播 `sessionDisposed`；未知 id → 失败。消费方纪律：dispose 前先 flush。
- `Session.append`（重载）：surface 词条必须带 `intent: { surfaceOp }`，log-only 词条禁带（类型 + 运行时双门）；**intent 本体另有运行时形状门**（null / 缺 `surfaceOp` / 形状不符 → `surface-op-invalid`，垃圾输入不崩）；失败门（未知类型 / data 非 JSON 安全 / 形状不符 / 已封存 / replace 区间非法 / intent 非法）→ `Result` 失败，日志零变动；成功返回冻结事件。seed 收养即深冻（宿主手造事件入账后不再持有可变别名）。
- **并发约束：一 session 一 writer**（进程内 store 独占写）。

### 1.6 Header 与格式身份

```ts
interface SessionHeader { id; createdAt; cwd?; parentSession? }
```

**无格式版本字段**（本仓无历史档案，不预埋演进机制）。格式身份判别 = **闭合词表 + fail-closed 校验**：未知词条/信封非法/投影悬空的档案读侧直接拒绝；追加式词表演进天然双向安全（旧运行时读新日志遇未知词条拒，新运行时读旧日志是子集恒可读）。**不变量：语义级变更（改既有词条含义、信封或 surface 机制）时必须引入显式判别字段——届时设计，字段缺失即可识别变更前档案**。

### 1.7 SessionArchive 端口（由 jsonl 插件 provide）

```ts
interface SessionArchive {
  list(): readonly SessionId[];
  read(id): Promise<Result<{ header: SessionHeader; events: readonly SessionEvent[] }>>;
}
```

### 1.8 jsonl 磁盘布局与落盘时序

- 布局：`<root>/<sessionId>/header.json` + `<root>/<sessionId>/events.jsonl`（逐事件一行 JSON）。
- **单一不变量（审查处置 P1/P3）：该会话的一切磁盘写只经 per-id 串行链**，四个入链来源，同链串行、绝不交错：
  1. `sessionCreated` → 首灌：初始化 pending 队列为**当前全量日志**（含构造期 seed 前缀与 end-seed——构造期事件不逐条广播、只经此首灌落盘），然后排空（打开 writer 并逐行写入）+ 写 header；同 id 重生（前一代已 dispose）时**整体重置 per-id 条目**（旧 closed/dead/degraded 不跨代），仅保留串行链让在飞终排空先完成；
  2. `sessionAuditEvent` → **实时段**：事件投递即入链 append（写 fd、不 fsync；监听器内仅入队，磁盘写在广播之外异步执行）。日志序前缀保证（结构性）：一切写入按 pending 前缀批 + 失败截断回滚——失败滞留事件与后续事件恒同批按序写出，乱序卷不可达。实时段降级闩 = 纵深防御：writer 一次 append 失败即保守停用实时段（事件只入 pending，每降级周期恰一次上报），屏障批量 + fsync 成功后恢复信任；writer 未就绪（晚装载/首灌在飞）/dead/closed 同样只入 pending；
  3. `sessionFlush` → 增量排空：append（幂等——实时段已写则空批）+ fsync，屏障返回 = 已 fsync；成功解闩 degraded 恢复实时段；
  4. `sessionDisposed` / 插件卸载 → 终排空 + 关 writer（close 幂等；链上 close 后再入排空段 = no-op，pending 已清）。
- `sessionAuditEvent` 投递面与排空兜底：微任务级投递、投递序 = 日志序（投递循环内 append 的事件续排本批之后；重入排空被卫兵挡回外层循环）。`store.flush` 的桥接 onFlush 先排空审计队列再派发 sessionFlush——「flush 成功 ⇒ 屏障发起前已 append 的事件已入 pending」（发起后同批在途事件在 drain 段执行前必已入账——drain 段至少晚一个微任务）；contextDisposing 广播（回卷最先、监听器全存活）与 `sessionAuditDrain` 端口（单插件卸载面拆除前调用）兜残余队列。created 必先于该会话一切审计投递（create 落账后才有活回路 append），队列无窗口。
- **排他创建与可验证续写（SESSION-RESUME §1.4）**：两级打开——`events.jsonl` `'ax'` 成功 → 全新档案（`header.json` `'wx'`；wx EEXIST 时孤儿 header 与当前 header 规范化相等则续写空卷 k=0，不等则撤销 dead）；`'ax'` EEXIST → **续写校验**：字节级尾态修复（截到最后换行）→ 磁盘卷是当前日志前缀（含相等，规范化深度相等）∧ 磁盘 header 相等 → `'a'` 追加续写并返回前缀长度 k（**首灌 pending 按k 裁剪，D 段永不重写**）；任一不过重抛 EEXIST → 现行重用 fail-closed（`session-id-reused`，旧档零损毁）。**并发边界：可验证 ≠ 独占——跨进程并发续写同一档案会交错腐蚀，单进程单写者部署是硬性前提（宿主保证）**。「同 id 重生」只剩两形态：带归档 header = 续写（resume），带新 header = dead；截断式恢复不支持（要截断用 fork）。dispose 不删档（历史保留）。
- 读侧：header 缺失 → 失败；header JSON 解析失败 → `corrupt-header`（含 `'wx'` 直写崩溃残缺窗口）；`events.jsonl` 不存在 = 空会话；**残行 = 位于文件末行且 JSON.parse 失败 → 跳过**（崩溃痕迹；末行 bit-rot 与撕裂不可分辨，接受项，审查处置 P12）；中间行损坏/信封非法/seq 断档/replace 反向区间 → 失败（`corrupt` 理由带行号）；seed 投影重放验证（replace 端点悬空）→ `corrupt-surface`。`list()`：root ENOENT = 空列表，其余环境错误（如 EACCES）上抛不静默折叠。
- **失败重试语义**：写段成功后才移除已写批次——append/fsync 失败时 pending 按序保留，下次 flush 重试（await 期间新到事件只追加尾部，按批次长度截断不误删）；writer.append 失败**截断回滚到批前长度**（同进程重试不产生重复字节，跨进程由续写前缀校验自愈）。实时段失败额外闩 degraded（见单一不变量第 2 条）——按会话去重上报一次（`session-realtime-append-failed:<id>`），屏障成功后重置。
- **永久性拒绝分类**（均闩 dead、区别于可重试瞬时 I/O）：`session-id-reused:<id>`（同 id 不同 header）/ `archive-orphan-events:<id>`（events 在 header 缺）/ `archive-corrupt:<id>`（中间损坏）/ `archive-prefix-mismatch:<id>`（磁盘非当前日志前缀）。读侧对称：header 在而 `events.jsonl` 缺失 → `no-events` 拒绝（不折叠为空会话静默丢史）。
- **晚装载 fail-closed**：持久化插件晚于会话创建装载（错过 `sessionCreated`）时，该会话后续 append 只入队不落盘，flush 失败 `writer-unopened:<id>`，绝不写出无 header 的档案。
- 路径安全：SessionId 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`（默认铸造天然合规）。
- 落盘口径：flush 屏障 = 文件 `fsync`；不 fsync 目录项（首次建目录后断电的极窄窗口，接受并记录）。
- I/O 失败路由：flush 路径错误经 `store.flush` Result 上浮（fail-closed）；created/disposed/实时段的 fire-and-forget 路径失败经可选 `onIoError` 上报（缺省 console.error；实时段按会话去重，writer 未就绪/dead 静默——flush fail-closed 上浮）。

## 2. 问题域

**处理**：会话事件日志的铸造/校验/追加/冻结；surface 投影与消息派生；会话生命周期（create/guard/fork/flush/dispose）与总线广播；jsonl 落盘与恢复读取；seed/resume 原料供给。

**不处理**（每项写清归属）：

| 不处理项 | 归属 |
| --- | --- |
| 何时 flush（检查点策略） | 消费方/后续 checkpoint 策略插件 |
| resume 的残 turn 崩溃修复（补 `turn/end{interrupted}`） | 消费方（agent-loop），经 `sessionArchive.read` 取原料、`create({id, seed, parent})` 回灌 |
| 压缩/滑窗策略本身 | 消费方插件（本件只提供 replace 原语） |
| 词表开放扩展（插件自铸词条 + 形状门注册） | 后续设计（需 gates 注册 API 配套）；当前词表闭合，未知词条写侧拒、读侧拒（§1.6） |
| 多进程/多实例并发共享会话 | 不支持——单进程单写者假设；跨进程**时序重用**同 id 已由排他创建拒（§1.8） |
| worker 模式参与 flush 屏障/持久化 | 不支持（worker 桥仅放行 emit 监听）；持久化插件必须 process 模式 |
| store 追踪持久化插件存续 | 不做——flush 为空屏障语义（§1.5）；装配责任归宿主 |
| header 写失败（非 EEXIST）的强一致保障 | emit 错误隔离 + `onIoError` 上报；events 落盘失败经 flush fail-closed；残缺 header 读侧拒 |
| fsync 目录项 | 接受窄窗口（§1.8） |

## 3. 并发/一致性预算

- `append`：同步、零 I/O、O(payload)（脱钩快照 + 深冻 + log push + 投影增量维护；emit token freeze=none，平台不重复深冻）。
- `replace`：O(surface) 定位 + 摘除（低频操作，surface 节点数千级内可接受）。
- `events()/surface()/deriveMessages()`：O(日志/投影) 快照副本，无副作用。
- `create`：O(1)；带 seed = O(N)（物化 + 信封白名单 + seq 连续 + 投影重放验证，单遍完成）。
- `fork`：O(N) 快照复制 + O(N) seed 重验 + 首灌 O(N) 落盘（一次性，本就要写盘）。
- `flush`：一次排空 = append（幂等，实时段已写则空批）+ 单次 fsync；同 id 串行链、不同 id 并行；无定时器。实测（APFS/NVMe/Bun）：实时段 ≈25µs/事件（含回滚锚 stat 两次异步 syscall），90 事件 turn 共 ~2.3ms——远低于 LLM 步延迟；屏障 fsync 清洁 ~12µs、脏 3KB ~46µs。
- 内存上界：成功路径 pending ≤ 实时段在飞链窗口内的事件数（微任务级）；降级期（段失败闩停）≤ 两次 flush 之间的事件数（由消费方检查点策略决定）。本件不设上限不丢事件。
- 竞态闭合：create 显式 id 并发 → birth 后二次占用检查恰一个成功；一切磁盘写经 per-id 串行链（created 首灌 / 审计实时段 / flush 增量 / disposed·卸载终排空互斥）；fork 经快照读取；worker 不参与屏障。

## 4. 拆分与依赖方向

```
packages/core/session/src/
  tokens.ts      # 9 token（sessionStore/sessionArchive/sessionAuditDrain 服务 + 6 总线）
  types.ts       # id/header/事件词表/信封/surface/接口/Result
  gates.ts       # 路径安全门/JSON 安全门/逐词条形状门/seed 信封+投影重放校验/replace 区间门
  id.ts          # mintSessionId（缺省铸号单一来源：UTC 时间戳-随机，跨进程唯一）
  surface.ts     # applySurfaceEvent（增量步进，单一真相）/ projectSurface / surfaceToMessages
  session.ts     # createSession（append/events/surface/deriveMessages/end-seed 构造/写权封存）
  store.ts       # createSessionStore（create/fork/get/list/flush/dispose + 并发闭合 + birth 路径）
  plugin.ts      # sessionPlugin（装配桥接回调 → token）
  index.ts       # barrel（coverage 豁免惯例）

packages/session-persistence-jsonl/src/
  archive.ts     # 读面：list/read + 目录布局 + 残行容忍
  writer.ts      # 写面：ax/wx 排他打开 / 事件追加 / fsync / close / 撤销
  plugin.ts      # 桥接装配：pending 队列 + per-id 串行链 + 生命周期 + 重用拒绝
  index.ts       # barrel
```

依赖方向：`session-persistence-jsonl → session → core`；无反向；无跨包 `__test__` 引用。

## 5. 实施顺序

1. session 包全量（types/gates/surface/session/store/plugin）+ 单测 → 四门；
2. persistence 包（archive/writer/plugin）+ 单测 → 四门；
3. 同批收口提交（定稿 → 已实施 同一提交推进）。

无过渡态、无双轨：词表闭合单轨、Result 单轨、无兼容层。

## 6. 裁决

- **用户裁决**：完整生产版（含 `request/context` 词条），不做 MVP/过渡版；方案先过子 agent 对抗审查再实现。
- 默认裁决（否决窗口已随方案展示）：create/fork 共用 guard 否决点（对应 DSH created-veto，映射内核 guard 模式）；fork 纳入首版（血缘 = header.parentSession + inherited 标记 + create 的 parent 回填）；`sessionCreated` 独立 emit token（否决在提交前、通知在提交后，两个事实两个 token）；构造期事件不广播、经 created 首灌落盘；jsonl 为首个持久化实现，archive 端口 token 留在 session 包（token 身份唯一来源）。
- 对抗审查处置：P1 构造期落盘=首灌；P2 fork 走 birth 路径；P3 per-id 串行链单一不变量；P4 dispose 封存写权；P5 末标记边界+parent 回填；P6 emit token freeze=none；P7 ax/wx 排他+重用 fail-closed；P8 空屏障语义；P9 空前缀非法；P10 计数 7；P11 语义级变更引入显式判别字段（无预埋版本机制）；P12 残行=末行 parse 失败。
- 代码对抗审查处置（第二轮，11 条全修）：intent 本体运行时门（`surface-op-invalid`，null/缺键/坏形状不崩不落账）；排空批次「写后移除」+ 失败按序保留重试；validateSessionEvents 拒反向 replace 区间；晚装载 `writer-unopened` fail-closed；seed 收养即深冻；isJsonSafe 环检测改祖先路径（DAG 重复引用合法）；AggregateError 展开保留全因；卸载先拆监听再排空；list() 区分 ENOENT 与环境错误；writer 回滚各步独立兜错；deriveMessages 元素深冻。

## 7. 测试口径

- **契约级**：token 词表封闭（导出名 ↔ §1.2 双向，含 freeze 档位）；事件信封判别联合穷举（13 词条逐条 append + 形状断言）；surfaceOp 仅 4 词条可带；`sessionCreated/sessionDisposed` 恰好一次且时序在落账后；flush 屏障聚合错误上浮；fork 广播 created（含 parentSession）且可被 guard 否决。
- **边界/异常表驱动**：门失败矩阵（未知类型 × 非 JSON 安全（undefined/函数/循环/Symbol/BigInt/NaN/Infinity/Date/Map/非普通原型） × 形状不符 × log-only 带 intent × surface 缺 intent × replace 端点缺失 × start>end）→ 全部 Result 失败且日志零变动；seed 非法（seq 断档/信封残缺/未知类型/投影悬空）；id 非法表（`../x`、`/abs`、空、超长、unicode、`-开头`）；`untilSeq` 边界两侧（-1 失败 / 0 合法 / len-1 合法 / len 失败）。
- **投影**：append 序、replace 单点/区间/跨 log-only seq 区间/连续 replace 叠加、deriveMessages 角色映射、快照不可变（返回后继续 append 不影响已取快照）、增量步进与全量 projectSurface 对拍。
- **store 并发/生命周期**：并发 create 同显式 id 恰一个成功；guard deny 零残留（list/get 空、无 created 广播）；dispose 后 append 返回 `session-disposed` 而读面开放；flush 未知 id 失败；resume 带 parent 血缘回填。
- **持久化**：round-trip（写→flush→卸载→重开 read 逐字节对账 header+events）；**首灌含构造期事件**（create-with-seed / fork 后 read = 全量日志含 end-seed）；flush 落盘 + fsync 序；并发 flush 同 id 串行不交错（断言写入行序）；dispose 链终排空（先 append 后 dispose 无 flush → 卸载后 read 全量）；末行残缺跳过 / 中行损坏失败 / corrupt header 拒 / 空会话（仅 header）读回；list 只认 header.json；**重用 fail-closed**（预置旧档后重建同 id → 旧档逐字节不变、flush 失败 `session-id-reused`、onIoError 收到上报）；onIoError 缺省路由不抛未处理拒绝。
- **回归**：开发中发现的每个 bug 一条用例，用例名注明症状。
- 分层：全部单测（进程内真实 fs：mkdtemp 目录）；无跨进程面，不新增 e2e 旅程（既有 e2e 场景不含会话，理由落档）。

## 8. 测试对照（vs deepseek-harness，2026-09-18）

**承接且等价或更强**：形状门表驱动（13+1 词条坏样本矩阵）、残尾崩溃两态（半行/无尾换行）、路径越权 id、并发 flush 串行不交错、字节级 round-trip、快照隔离、重用 fail-closed、JSON 安全门全表（循环/DAG/Symbol/BigInt/稀疏/原型污染）、TOCTOU 定影与脱钩（DSH json.spec/materialize 语义）、六态 turn/end reason 往返、种子化随机日志的代数性质（seq 连续/派生确定/增量==全量/重放等价/log-only 无感）。

**不承接（机制不存在，复制即投机——用户裁决：参照只取机制思想）**：格式世代迁移/zstd 压缩/跨进程文件锁/Windows 发布路径（DSH 为部署存量服务，本仓无存量）；`sourceEventSeqs` 引用与区间编码（本仓 replace 只带区间，已裁决）；prepare/enter/announce 三段拆分及其重入竞态（单 birth 路径）；system 节点路由特判（system/message 是普通 surface 节点）；冷读 memo/单飞历史准备（全量读足够）。

**归属后件**：结构不变量伴随插件（turn/step 括号纪律）→ agent-loop 件；崩溃修复 interruptedTurnClosers 全部语义（平衡卷零修复/step 先 turn 后闭合/not-started vs outcome-unknown/多调用顺序/孤儿 tool-call 优雅）→ agent-loop repair；checkpoint fail-closed 全矩阵 → session-checkpoint 件。三件的独立文档必须逐条承接上述清单。

**三路独立审计处置（2026-09-18，多子 agent 并行）**：① 门-账 TOCTOU 发散（getter 两遍读）→ 物化先行根治，`isJsonSafe` 谓词删除（materializeJson 单一真相）；② replace 区间三处重复实现 → `applySurfaceEvent` 返回判别联合成为唯一真相（append 落账前先算步进），`gateSurfaceOp` 删除；③ 孤儿 header 投机续写分支与「events 缺失=空会话」静默丢史路径成对删除/改 fail-closed；④ 终排空失败 fd 泄漏 → 无条件 close 后重抛；⑤ `rootReady` 冗余层删除（writer mkdir 覆盖）；⑥ 拒绝报文按来源分类（原一律 session-id-reused 误导运维）；⑦ `Result`/`errorText` 迁 core；⑧ flush 载荷 `{flushed:true}`→`true`；⑨ 信封键白名单 + isCount safe-integer + time 非负；⑩ usage 形状门；⑪ 监听器重入 append 卫兵（拒 `append-reentrant` 防栈溢出）；⑫ 故障注入测试补全（FileHandle 原型拦截：半写回滚/并发串行/重生链继承/close 不泄漏）。

## 9. 验收清单

- [x] §1.2 token 词表 / §1.3 事件词表 / §1.4 replace 语义逐条（plugin.test 词表封闭 + 13 词条穷举 + surface.test 投影语义）
- [x] §1.5 API 全签名与错误形态逐条（含空屏障、写权封存、parent 回填；store.test / session.test）
- [x] §1.8 布局/串行链不变量/排他创建/读侧容忍规则逐条（writer/archive/plugin 三测试文件）
- [x] 门失败矩阵表驱动逐条（gates.test / session.test 门失败矩阵）
- [x] 并发/一致性预算逐条（并发 create/flush 串行/重生重置/快照隔离用例）
- [x] 四门全绿 + 覆盖率：319 用例全过；总覆盖率 行 93.52 / 语句 91.95 / 函数 94.08 / 分支 95.13（阈值 90/90/90/85）；新增包 session 96.7/96.25/100/99.05、persistence-jsonl 92.66/86.3/88.09/97.58；e2e 无回归
- [x] 对抗审查问题清零（方案审 12 条 + 代码审 11 条全部处置并带回归用例）
