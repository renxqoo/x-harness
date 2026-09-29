# HUB-CLIENT SDK 设计基线（host-hub 进程客户端 SDK：企业级）

> 状态：**草稿**（文档对抗审查 → 用户定稿 → 实施）
> 级别：**大**（跨应用、新子系统、契约重组；无不可逆存量数据变更）
> 方法论：feature-dev-v2（借件：借存量审计纪律与装置适配记录，收口按本工作流清单）
> 上游裁决：2026-09-29 对话（命令面盘点 → SDK 形态 → 多用户组网）。

---

## 0. 背景、目标与非目标

### 0.1 现状（存量面盘点）

host-hub 暴露 **79 命令**（`apps/host-hub/src/protocol/commands.ts` 封闭集）的 JSONL
进程协议（stdin 命令 / stdout 帧）。命令分四域：host 本地（线程生命周期/模型/凭据）、
管理面（settings/skills/agents/plugins/permission/trust）、parked/dead 直读接管、
线程域（37 个交池转发 worker）。

协议契约目前住在 host-hub 内部（`protocol/` + `shared/`），已有**三个各自为政的客户端
形态**证明需求真实：

| 存在形态 | 位置 | 缺陷 |
|---|---|---|
| gateway host-attach | `apps/hub-gateway/src/host-attach.ts` | spawn/心跳死线/重启耦合 gateway 语义，帧分类镜像（fanout.ts 本地复制） |
| 测试装置 | `apps/host-hub/src/__test__/kit/host-client.ts` | 测试专用，无类型、无对账纪律、不导出 |
| remote-client | `packages/remote-client/src/connect.ts` | 面向 relay 远程链路，非本机进程形态 |

没有任何宿主能以「库」形态驱动 host-hub；契约（帧/key 序/错误码/词表）无法被外部
消费端单源引用。

### 0.2 目标

把 host-hub 命令面变成**任何服务可嵌入的进程客户端 SDK**：

1. **方法调用返回 JSON**：`hub.call("thread/list")` → response 帧 parse 后原样返回
   （零包装、零信息损耗），业务失败是返回值分支不是异常；
2. **多消费端**：web 服务端（多用户多 session）、cli、hub-gateway、hub-relay、
   host-hub 自身（契约单源消费方）；
3. **契约单源**：帧/词表/错误码/分帧从 host-hub 抽出为独立契约包，四方共同消费，
   消灭一切镜像；
4. **可观测内建**：指标快照、结构化日志缝、原始帧调试缝、心跳健康透传——消费端
   不改代码即可接自己的 metrics/日志/trace 体系；
5. **可维护**：传输无关核心（未来加远程传输不改命令层）、命令增删有封闭性门禁、
   类型面增量演进。

### 0.3 非目标

- 不做 HTTP/WS **服务**（SDK 是库，服务端由消费端组装；用户裁决 U1/U2）；
- 不改 wire 协议（帧形态、key 序、错误码表、命令词表逐字节不动——SDK 是既有协议上层）；
- 不做自动重连/重启（进程策略归消费端，SDK 只如实报告 `exited`；见 D3/D10）；
- 不做远程传输（relay/WS 形态后续按传输扩展点加，见 §6.3）；
- 不做命令级重试（幂等性是命令属性，SDK 无法安全重试；见 D10）；
- 不动 host-hub 命令处理器行为（本方案只做契约搬家与客户端新增）。

---

## 1. 裁决记录

### 1.1 用户裁决

| # | 裁决 | 出处 |
|---|---|---|
| U1 | SDK = host-hub **子进程客户端**（spawn + 方法调用走既有 JSONL 协议），不是把 host 实现搬进库函数 | 2026-09-29 |
| U2 | 方法调用**直接返回 JSON**（response 帧 parse 后原样返回），任何消费端通用 | 2026-09-29 |
| U3 | 多用户多 session 是首要服务端场景：**用户 → host 进程（隔离单元），session → thread（并发单元）**；跨租户每用户一根 host，同租户多 session 共享 host 多 thread | 2026-09-29 |

### 1.2 默认裁决（否决窗口内可改）

| # | 裁决 | 理由 |
|---|---|---|
| D1 | 包位置 `packages/hub-protocol` + `packages/hub-client`（**非** apps/） | 库被 apps 依赖；与 remote-protocol/remote-client 既有分包先例一致；依赖方向干净（host-hub 不得依赖「spawn 它的客户端」） |
| D2 | `call()` **永不 reject**（connectHub 的 reject 是唯一例外——spawn 失败/无心跳时无已发呼叫）；业务失败 = `success:false` 分支；传输失败 = 合成同构 response（code=protocol） | 消费端（HTTP handler 等）不需要 try/catch 包一层；错误码表不扩项 |
| D3 | 不自动重启：暴露 `exited` + `exit` 事件 + `close()/kill()`；重启策略归消费端 | gateway 现有 kill&restart、web 服务端重建策略语义不同，库不该持策略 |
| D4 | 呼叫超时缺省 60s，逐呼叫 `timeoutMs` 覆盖（0/Infinity 关闭）；超时结算后晚到响应丢弃+计数 | bash/长命令由调用方显式放宽；晚到不复活已结算 promise |
| D5 | 命令面只做通用 `call(command, args?)` + 类型映射表联动收窄，不手写 79 个方法糖 | vocab 单源在 hub-protocol；命名糖等真实用量后增量（防止拍脑袋发明 79 个名字） |
| D6 | gateway `host-attach` 整体迁移不在本期（其多设备路由/tier/重启语义独立，留专项）；本期只消灭 fanout 帧分类镜像 | 控制爆炸半径；镜像消灭已拿全契约单源收益 |
| D7 | `createHubPool` 池化组件**进包**（纯逻辑、工厂注入、无重启策略） | 每个服务端消费端都要写，并发去重/退出清理/空闲回收细节易错；纯逻辑可全单测 |
| D8 | 观测面 = `stats()` 拉模型快照 + `log` 注入缝 + `onRawLine` 调试缝 + `on("heartbeat")` 透传；不绑任何 metrics 实现 | 消费端接 Prometheus/日志/trace 自由；库零依赖噪音 |
| D9 | response data 类型**增量标注**：第一批高频命令，映射表 `CommandResponses` 可扩充；未标注命令 data 落 `unknown` | 类型住 hub-client（wire 真源仍 host 侧），契约测试抽样对拍；全量 79 命令一次性标注不可持续 |
| D10 | 不内置命令重试 | `thread/start` 重试会 already_open、`prompt` 重试会双发——幂等性是命令属性；降级重试（`streaming_window` 等）归消费端按错误码语义 |
| D11 | 池空闲回收策略注入（`idleTtlMs`，缺省 0 = 不回收）；无引用计数 | web 形态 hub 长驻于用户会话而非单请求，TTL 兜底 + 管理面显式 evict 足够 |

---

## 2. 总体架构

### 2.1 分层与依赖方向

```
                        ┌───────────── 消费端 ─────────────┐
                        │  web 服务端(多用户)   cli(未来)   │
                        └──────────────┬───────────────────┘
                                       │ createHubPool / connectHub
                        ┌──────────────▼───────────────────┐
                        │  packages/hub-client（SDK 本体）  │
                        │  pool │ connect │ process │ core │
                        └──────────────┬───────────────────┘
                                       │
                        ┌──────────────▼───────────────────┐
                        │ packages/hub-protocol（契约单源） │ ← 零依赖（node 内置除外）
                        └──┬──────────┬──────────┬─────────┘
                           │          │          │
                 host-hub ─┘  gateway ┘  relay ──┘（只消费契约：造帧/分类/词表/类型）
```

不变量：

- **hub-protocol 零 @x-harness 依赖**（仅 node 内置）——host-hub、hub-client、gateway、
  relay 四方共同底座；不进内核组（check-kernel-deps 扫描集不变）；
- **host-hub 不依赖 hub-client**（被 spawn 方不依赖 spawn 方——否则测试图成环）；
- **hub-client core 不 import node:child_process**（传输无关；进程语义只住 process 传输层）。

### 2.2 设计原则

1. **单一真相**：帧构建/分类、命令词表、错误码、行上限、分帧器各只有一份，住
   hub-protocol；删 host-hub 原件与 gateway 镜像，不留别名不留双轨（过渡规则见 §9）。
2. **薄而不蠢**：SDK 不复验 host 侧校验（unknown command 由 host 拒）、不缓存 host
   状态、不做命令语义——只做进程生命周期、对账、分发、观测。
3. **策略注入**：重启、重试、metrics、日志、空闲回收全部是注入缝，库内零策略。
4. **如实失败**：传输层失败合成同构 response 并在 `exit`/`stats` 里留下事实，不吞
   不折平。

---

## 3. 包契约：`@x-harness/hub-protocol`

### 3.1 移动清单（移动非复制——host-hub 原件删除、导入翻转）

| 现位置（apps/host-hub/src） | 去向（packages/hub-protocol/src） | 内容 | 备注 |
|---|---|---|---|
| `shared/errors.ts` | `errors.ts` | HUB_ERROR_CODES（31）、HubErrorShape、hubError、isHubErrorShape、CodedError、errorOfCause | 四方共消费 |
| `shared/frame-classify.ts` | `frame-classify.ts` | classifyResponseHead、responseLine（response 帧 key 序单点） | |
| `protocol/frames.ts` | `frames.ts` | 七个帧构建器 + SettledEvent/BashExecutionUpdate | 增补 §3.2 类型 |
| `protocol/commands.ts` | `commands.ts` | COMMAND_NAMES（79 封闭集）+ 入参形状（ThreadStartSpec/PromptSpec/…） | 依赖的 `shared/images.ts`（WireImage）随迁 `images.ts` |
| `protocol/internal.ts` | `command-domains.ts` | INTERNAL_ID_PREFIX、THREAD_SCOPED/HOST_RELAYED/OBSERVER/DRIVING 四集合、isThreadScoped、isInternalId | **HelloFrame/WorkerHeartbeat/WORKER_PROTOCOL_VERSION 留 host-hub**（host↔worker 私有握手，客户端不可见） |
| `shared/jsonl.ts` | `jsonl.ts` | createJsonlSplitter（LF 唯一分隔、容忍 \r、超限恰报一次、字节域定界不劈码点） | client↔host 双侧同源 |
| `shared/limits.ts` 的 `CLIENT_LINE_LIMIT` | `line-limit.ts` | 16MiB 行上限 | limits.ts 其余留 host-hub，反向导入 |

### 3.2 增补（客户端消费面需要、现散落或缺失）

```ts
// frames.ts：parse 后的帧判别联合（构建器已有、类型未有）
export type HostResponse =
  | { type: "response"; id?: string; command: string; success: true; data?: unknown }
  | { type: "response"; id?: string; command: string; success: false; error: HubErrorShape };
export interface HostEvent { type: "event"; threadId: string; name: string; payload: unknown; agentName?: string }
export interface HostUiRequest { type: "ui_request"; requestId: string; threadId: string; method: string; payload: Record<string, unknown> }
export interface HostHeartbeat { type: "heartbeat"; rssBytes: number | null; cpuPercent: number }
export interface HostHubError { type: "hub_error"; message: string; threadId?: string }
export interface HostThreadDied { type: "thread_died"; threadId: string; reason: string }
export interface HostThreadParked { type: "thread_parked"; threadId: string; reason: "idle" | "manual" | "rss" }

// frame-classify.ts：全类型前缀分类（response 恒 id-first，其余 type-first——
// 与 host 帧构建器 key 序单点对拍；吸收 gateway fanout.ts 的 classifyHostLine 镜像）
export type HostFrameKind = "response" | "event" | "ui_request" | "heartbeat" | "hub_error" | "thread_died" | "thread_parked" | "unknown";
export function classifyHostLine(line: string): HostFrameKind;
```

### 3.3 封闭性门禁（hub-protocol `__test__`，从 host-hub contracts 迁移并扩容）

- COMMAND_NAMES = 79 无重复；四集合 ⊆ 词表；驱动 ⊂ 线程域；观察者 ⊂ 线程域 ∪ 转发
  白名单；转发白名单 ∩ 线程域 = ∅；
- HUB_ERROR_CODES = 31、isHubErrorShape 对全部码真、对垃圾假；
- classifyHostLine 与帧构建器往返对拍（含 id 转义字符、无 id parse-failure 形态）；
- jsonl 分帧器边界（跨 chunk 多字节、\r、超限恰报一次）。

新增命令/错误码/帧类型只改 hub-protocol 一处，封闭性测试即时钉住（演进流程见 §6.2）。

---

## 4. 包契约：`@x-harness/hub-client`

### 4.1 文件架构（一一动词一文件）

```
packages/hub-client/src/
  index.ts            出口（connectHub/createHubPool/类型）
  ids.ts              呼叫 id 铸造（唯一性/保留前缀守卫）
  events.ts           事件总线（on/off/分发保序/回调异常隔离）
  stats.ts            观测计数器（单一可变快照，reset 语义）
  core.ts             会话核心：pending 表/超时/对账/行超限本地拒/exit 结算（传输无关）
  transport.ts        传输抽象面：send(line)/onLine(cb)/closed()/kill()（纯接口）
  process.ts          process 传输实现：spawn + JSONL 泵 + 心跳死线监督 + 背压 drain
  resolve-host.ts     hostBin 解析序（显式 → 仓库源入口 → dist 产物 → 拒启）
  connect.ts          connectHub 装配（ready 判定/exit 结算/观测缝接线）
  command-types.ts    CommandResponses 映射（D9 增量类型面）
  pool.ts             createHubPool 多路复用池（D7：纯逻辑、工厂注入）
  __test__/           单元（假传输）+ 契约（真 host 进程，script 假 worker）+ kit/
```

依赖纪律：core/events/stats/ids 无 node 进程 API（假传输全单测）；process 是唯一
`node:child_process` 触点；pool 只依赖 connect 返回的 Hub 接口。

### 4.2 连接生命周期 API

```ts
import { connectHub, createHubPool } from "@x-harness/hub-client";

const hub = await connectHub({
  // 进程
  hostBin?: string,               // 缺省解析序见 resolve-host.ts
  agentDir?: string,              // 缺省 ~/.x-harness/hub
  sessionsRoot?: string,          // 缺省 <agentDir>/sessions
  env?: Record<string, string | undefined>,
  // 监督
  heartbeatDeadlineMs?: number,   // 缺省 15_000（host 心跳 1Hz）
  callTimeoutMs?: number,         // 缺省 60_000
  killTimeoutMs?: number,         // kill() SIGTERM→SIGKILL 宽限，缺省 5_000
  // 观测缝（D8；全部缺省安全）
  log?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void,  // 缺省 noop
  onRawLine?: (line: string, dir: "in" | "out") => void,   // 调试缝，缺省无
  onHandlerError?: (error: unknown, kind: string) => void, // 事件回调异常兜底，缺省 stderr 一行
  // 测试缝
  spawn?: typeof spawn,
  now?: () => number,
});
```

**ready 判定**：首帧心跳到达才 resolve（host 心跳先于慢速装配，启动窗口有覆盖）。
spawn 失败 / 死线内无心跳 → **reject**（唯一 reject 面；此时无已发呼叫、无资源泄漏）。

**句柄面**：

```ts
hub.call<K extends keyof CommandResponses & string>(command: K, args?: CommandArgs[K], opts?: { id?: string; timeoutMs?: number }): Promise<HostResponse & { data?: CommandResponses[K] }>;
hub.on("event", fn: (e: HostEvent) => void): void;         // 全事件
hub.on("event", "settled", fn: (e: HostEvent) => void): void; // 事件名过滤重载
hub.on("ui_request" | "heartbeat" | "hub_error" | "thread_died" | "thread_parked", fn): void;
hub.on("exit", fn: (info: ExitInfo) => void): void;
hub.off(kind, fn): void;
hub.stats(): HubStats;            // §4.5 快照（只读拷贝）
hub.exited: Promise<ExitInfo>;    // { code: number | null; reason: "closed" | "heartbeat-deadline" | "killed" | "exited" }
hub.close(): Promise<void>;       // stdin.end() → host EOF 优雅停机 → 冲刷 → resolve；幂等
hub.kill(): Promise<void>;        // SIGTERM → killTimeoutMs → SIGKILL 兜底
```

### 4.3 `call` 语义细则

- **id 铸造**：缺省 `c<单调序>`；铸造器永不产出 `@hub-internal:` 前缀（保留前缀常量
  从 hub-protocol 导入做守卫——客户端 id 不得冒充 host 内部命名空间）。自定义 id 撞
  在飞 id → 本地合成 failure（protocol），不写管道。
- **序列化与行上限**：`JSON.stringify` 后超 `CLIENT_LINE_LIMIT`（16MiB）→ 本地合成
  failure（protocol, "line exceeds limit"），**不写管道**——host 侧会丢弃+发无 id 的
  parse failure，本地拒绝对账完整。
- **对账**：response 帧按 id 恰结算一次（resolve/reject 均算）；超时结算后晚到响应
  丢弃 + `stats().lateResponsesTotal` 计数；`success:false` 且 `isHubErrorShape(error)`
  为假的帧（垃圾形状）→ 按协议失败结算（不吞、计数）。
- **传输失败合成**（进程退出/心跳死线/超时/写失败/已 close）：
  `{ type:"response", id, command, success:false, error:{ code:"protocol", message:"hub-client: <事实>" } }`
  ——与 host 的 "worker died"/"shutting down" 同族，错误码表不扩项；消费端用
  `exit` 事件与 `stats()` 区分「host 拒了」与「连接断了」。
- **透明路由**：parked/dead 直读接管、池路由、trusted 门禁全部是 host 内部分派，
  SDK 不感知不复制。
- **背压**：stdin write 返回 false → await drain；写失败走传输失败路径。

### 4.4 事件与副作用时序（一次性事件恰好一次）

1. 事件回调在帧到达序内**同步**调用（单 stdout 泵、全序、不乱序不并发）；回调抛错
   进 `onHandlerError`，不中断分发、不影响 pending 结算。
2. 进程退出固定三步：全部 pending 立即合成 failure 结算 → `exit` 事件 → `exited`
   resolve；恰好一次、次序不变。
3. `close()`：stdin.end → host EOF 优雅停机（worker 收编、末帧冲刷）→ exit(code 0)
   → resolve；重复调用幂等（返回同一 promise）。close 后 `call()` → 合成
   failure（protocol, "shutting down"）。
4. `kill()`：SIGTERM（host 的 shutdown 处理器收 worker）→ 宽限超时 SIGKILL；SIGKILL
   后 host 的 worker 孤儿风险由 worker 侧 stdin EOF 退出语义兜底（契约测试验证）。
5. 心跳死线：超 `heartbeatDeadlineMs` 无心跳 → 标记失活 → 走退出三步
   （reason=heartbeat-deadline），进程按 kill 路径收割。

### 4.5 观测面（企业级接入点）

```ts
export interface HubStats {
  // 生命周期
  connectedAt: number;               // epoch ms
  hostPid: number | null;
  // 呼叫健康（消费端告警的锚点）
  callsTotal: number;
  callsBusinessFailed: number;       // host 应答 success:false
  callsTransportFailed: number;      // 合成 failure（超时/退出/超限/写失败）
  timeoutsTotal: number;
  pending: number;                   // 在飞（泄漏检测：稳态应归零）
  lateResponsesTotal: number;
  // 流量
  sentLines: number; recvLines: number;
  sentBytes: number; recvBytes: number;
  oversizeRejectedTotal: number;
  // 事件面
  eventsTotal: number; handlerErrorsTotal: number;
  // host 健康（心跳透传累积——进程级监控锚点）
  lastHeartbeatAt: number | null;
  lastHeartbeatRssBytes: number | null;
  lastHeartbeatCpuPercent: number | null;
  deadlinesTotal: number;            // 心跳死线累计
}
```

消费端接入模式（零库内依赖）：

- **Prometheus 等 pull 型**：定时刮 `hub.stats()`（或 `pool.stats()` 聚合）映射到自家
  counter/gauge；
- **日志**：`log` 缝收生命周期事件（spawn/ready/exit/deadline/close，结构化 fields 含
  pid/reason/耗时）；库对 env 等敏感字段不落日志；
- **trace/调试**：`onRawLine` 双向原始帧钩子（默认关闭零开销）；
- **健康检查**：`stats().lastHeartbeatAt` 距今 + `pending` 是就绪/积压探针的两块事实。

### 4.6 类型面（D9 增量标注）

```ts
// command-types.ts：映射表可增量扩充；未标注命令 data 落 unknown
export interface CommandResponses {           // 第一批（高频 + 服务端组网必需）
  "thread/list": { threadId: string; cwd: string; sessionPath: string; state: string; ... }[];
  "thread/list_saved": { sessions: SavedSession[] };
  "get_host_info": { version: string; threads: { live: number; parked: number; dead: number }; limits: ...; errorCodes: string[] };
  "get_models": { models: CatalogEntry[] };   // CatalogEntry 自 hub-protocol catalog-types 随迁
  "agents/list": { agents: { name: string; description: string; source: "builtin" | "user" | "project" }[] };
  "skills/list": { skills: ... };
  "plugins/list": { plugins: ... };
  "settings/get": { values: ...; sources?: ... };
  "auth/list": { credentials: ... };          // 形状以 host 处理器为准，契约测试对拍
  "get_state": SessionStateShape;
}
export interface CommandArgs { /* 同法：commands.ts 入参形状已单源，此处挂同名键 */ }
```

类型是**标注不是验证**：wire 真源在 host 处理器；契约测试（script 装置）抽样断言
字段形状防漂移。

### 4.7 池化组件 `createHubPool`（U3 落地，D7/D11）

```ts
const pool = createHubPool({
  acquire: (key: string) => connectHub({ agentDir: agentDirOf(key) }), // 工厂注入（key=userId 等）
  onExit?: (key: string, info: ExitInfo) => void,   // 重启策略挂点（缺省仅移除槽位）
  idleTtlMs?: number,                               // 空闲回收（缺省 0 = 不回收）
  evictTimerTickMs?: number,                        // 回扫间隔（缺省 30s）
});

await pool.hub("user-42");        // 并发去重（同 key 并发 → 同一 spawn）；hub 建立后 on("event") 由消费端挂
await pool.evict("user-42");      // 管理面显式关停（强制下线）
pool.keys(): string[];
pool.stats(): Record<string, { stats: HubStats; lastAcquireAt: number }>;  // 每用户健康聚合
await pool.closeAll(): Promise<void>;
```

池职责边界：**只管槽位生命周期**（去重/退出清理/TTL 回扫/evict），不管事件路由
（消费端在 `hub()` 返回的句柄上自挂）、不管重启（onExit 注入）。纯逻辑全单测
（假 connectHub 工厂）。

### 4.8 多用户多 session 组网（参考架构，U3）

**维度拆分**：用户 → host 进程（隔离单元）；session → thread（并发单元）。
host-hub 账本是线程表 + 单 agentDir（凭据/settings/skills/trust 进程共享）——
「用户」边界必须由服务端用进程画：

| 形态 | 适用 | 隔离事实 |
|---|---|---|
| 每用户一根 host | 跨租户 | agentDir/sessionsRoot 全隔离；BYO key 可行；事件天然无跨用户泄漏；崩溃半径单用户 |
| 共享 host 多 thread | 同租户多任务（或 cli 单人） | 一根进程 N thread；凭据/trust 共享（`trustedCwds` 是注册表 ∪ live 并集——跨租户下是泄漏面，禁用） |

session 是磁盘事实（`<sessionsRoot>/<threadId>/events.jsonl`），活得比进程久：

- 列历史：`thread/list_saved`（host 直读盘，零 worker）；
- 浏览不续聊：parked 态 `get_state`/`get_entries` 由 host 直读应答（免唤醒）；
- 续聊：`thread/resume`（拉 worker）；新任务：`thread/start`；
- 容量调度用 host 内建：idle retire（缺省 15min，`set_idle_retire_ms` 可调）自动
  park 回收 worker、rss retire 强收编、maxThreads 上限（超发 `thread_limit`）——
  稳态 = 每用户一根轻 host + 仅活跃 session 挂 worker。

**并发纪律**：一个 thread 同时只有一个 turn（在飞时 `prompt` 会被 `streaming_window`
拒）；服务端按 `userId:threadId` 串行化队列，跨 thread 完全并行（pending 按 id 对账，
天然并发安全）。

**事件路由**：`route(userId, e.threadId)` 两段键拼接才完整；审批 `ui_request` 的
requestId 是 thread 内一次性令牌，回传 `call("ui_response", { requestId, ... })`。
共享 host 模型下漏按 userId 过滤 = 跨租户泄漏，池形态（每用户一根）结构上免疫。

**重启恢复**：懒恢复——服务端重启后用户回来才 `list_saved + resume`，不启动时全量
拉起；多节点横向扩（sessionsRoot 上共享存储的 realpath/fsync 语义）是部署层专项，
SDK 不解决不假装解决。

---

## 5. 问题域

**处理**：契约抽包与单源化（§3）、SDK 连接生命周期/呼叫对账/事件分发/观测面（§4.1-4.5）、
类型面第一批（§4.6）、池化组件（§4.7）、host-hub 导入翻转与测试装置迁移（§9 阶段五）、
gateway fanout 分类去重（D6 范围内）。

**不处理**（归属写清，不留白）：

| 不处理项 | 归属 |
|---|---|
| 自动重启/重连 | 消费端（pool.onExit 注入；gateway 自持 kill&restart） |
| 命令重试/降级 | 消费端按错误码语义（D10） |
| 远程传输（WS/relay） | 后续传输扩展（§6.3）；远程端现走 remote-client 链路 |
| 79 命令 data 全量类型 | 增量演进（§4.6 流程） |
| host 命令处理器行为 | host-hub（本方案不动） |
| gateway host-attach 迁移 | 后续专项（D6） |
| ui_response 审批语义编排 | 消费端（SDK 只透传） |
| 多节点共享存储 | 部署层专项（§4.8） |
| 命令合法性复验 | host（unknown_command 单一闸门） |

---

## 6. 可维护性与演进

### 6.1 契约测试钉住（防漂移机制）

- 封闭性测试（§3.3）钉词表与集合关系——新增命令漏登记即时红；
- key 序对拍（classifyHostLine ↔ 帧构建器往返）钉帧形态——改 key 序即时红；
- SDK 契约测试 spawn **真 host 进程**（`HUB_WORKER_PROVIDER=script` 假 worker，无
  LLM 依赖）钉端到端行为——host 行为变化导致 SDK 面破实时即时红。

### 6.2 命令/错误码/帧演进流程

新增命令：host-hub 处理器 → hub-protocol COMMAND_NAMES + 入参形状（同一提交）→
（可选）hub-client CommandResponses 标注。删除同理反向。封闭性测试是唯一门禁，
无别的登记处。

### 6.3 传输扩展点

`transport.ts` 纯接口（send/onLine/closed/kill）。未来远程形态 = 新增传输实现文件
（如 `remote-transport.ts` 挂 relay 链）+ connect.ts 加装配分支；core/events/stats/
pool 零改动。这是 core 不 import child_process 的回报。

### 6.4 协议版本策略

client↔host 无版本握手（帧分类是字节级前缀事实）。同仓 monorepo、private 包锁步
发版，无跨版本兼容承诺；消费端与 host 的版本对齐由部署保证（文档记入包 README）。
不发明版本协商。

---

## 7. 测试口径（先于实现定稿）

### 7.1 单元层（core/events/stats/ids/pool，假传输/假时钟）

- id 铸造：唯一、单调、永不保留前缀；自定义 id 撞在飞 → 本地 failure；
- 对账：按 id 恰结算一次；晚到丢弃+计数；垃圾 error 形状按协议失败结算；进程退出
  全部 pending 合成 failure；
- 超时矩阵：缺省/per-call 覆盖/0/Infinity 关闭/超时与正常结算竞态（假时钟推进序）；
- 事件总线：帧序保序、同步回调、回调抛错隔离、off 解绑、事件名过滤重载；
- 行超限：16MiB+1 本地拒、不写管道、计数；
- stats：计数器单调、快照只读（外部改不动内部）、reset 语义；
- pool：并发 hub(key) 去重（同 key 并发 → 单 spawn）、exited 清槽、onExit 回调、
  idleTtl 回扫 evict、evict/closeAll 幂等、stats 聚合；
- close 语义：幂等同 promise、close 后 call 合成 failure、exit 三步次序恰好一次
  （固定断言次序）。

### 7.2 契约层（真 host 进程 + script 假 worker）

- ready：首帧心跳 resolve；spawn 失败/无心跳 reject（唯一 reject 面）；
- 表驱动命令抽样：host 本地（thread/list、get_host_info、get_models、settings/get、
  plugins/list、unknown → unknown_command 透传）+ 线程域全链（thread/start →
  prompt → settled 事件 → get_state → thread/stop）+ CommandResponses 第一批形状
  对拍；
- ui_request 往返（script 剧本触发 → on 回调 → ui_response 应答）；
- 心跳死线：缩死线 + 卡死 host → exit(reason=heartbeat-deadline) + pending 合成
  failure + stats.deadlinesTotal；
- 优雅 close → host exit 0；kill → SIGTERM 收编（无孤儿 worker，验证 §4.4-4）；
- 观测：stats 计数与真实往返一致（callsTotal/bytes/eventsTotal）。

### 7.3 封闭性（hub-protocol，§3.3 全量）

### 7.4 回归与 e2e

- 开发中发现的每个 bug 带症状命名回归用例；
- e2e 不加新旅程：契约测试即真子进程全链（仓库既有惯例）；`bun run e2e` 不动；
  阶段五 host-hub 装置迁移后全量 host-hub 测试绿 = 迁移正确性背书。

---

## 8. 并发/一致性预算（数字化硬约束）

- **定时器**：≤ 2 常驻（心跳死线检查 1s 间隔 + pool 回扫 30s 间隔）+ 每在飞呼叫 1
  超时定时器（结算即清，稳态为 0）；
- **内存上界**：行缓冲 ≤ 16MiB/连接（分帧器字节域定界）；事件不缓存（无 replay
  buffer——replay 是 gateway/remote 层职责，SDK 是热消费）；
- **pending 表**：Map 无硬上限（host 侧 PENDING_COMMANDS_CAP 65_536 是真闸门；
  SDK 侧泄漏检测 = 稳态 stats().pending 归零断言）；
- **单写者纪律**：stdout 泵单 listener 顺序分发；SDK 内部无锁（单事件循环假设）；
- **回调内禁 IO 纪律**：SDK 自身事件回调路径无 IO；消费端回调阻塞会背压帧分发
  （同步分发的如实代价，文档记入 README）。

---

## 9. 实施顺序（每阶段独立提交、四门全绿；de-risk 切片 = 阶段一）

1. **阶段一 契约抽包**（de-risk：独立可验证、可回滚、验证流程本身）：建 hub-protocol，
   §3.1 七项移动 + §3.2 增补；host-hub 删除原件、导入翻转；contracts 纯协议测试迁移；
   gateway fanout 换导入（删镜像）。验收：四门绿 + 封闭性断言在新包内绿 +
   host-hub/gateway 全量测试绿。
2. **阶段二 hub-client core 纯逻辑**：ids/events/stats/core + command-types 骨架；
   假传输全单测。验收：core 系覆盖率 ≥ 阈值。
3. **阶段三 process 传输 + connectHub**：process/resolve-host/connect + 真 host
   契约测试。验收：§7.2 全绿。
4. **阶段四 pool + 观测面收口**：pool.ts + stats 聚合 + log/onRawLine 缝 + 包 README
   （对外行为、消费端接入、观测接入模式、§4.8 组网参考）。
5. **阶段五 存量收口**：host-hub `__test__/kit/host-client.ts` 迁至 hub-client
   `__test__/kit/`（旧装置删除，host-hub 测试改用 SDK——dogfood；单轨）；镜像清零
   核查（grep 无本地 classifyHostLine/frames 副本）；覆盖率与验收清单核销。

过渡态规则：阶段一后 host-hub 内**零残留副本**（移动即删，无过渡双轨）；阶段五前
hub-client 内零测试专用 host 装置副本（kit 单点在 hub-client）。

---

## 10. 验收清单

- [ ] U1/U2/U3 契约逐条：call 返回 response JSON 原样（永不 reject）；多用户组网按 §4.8 可组装
- [ ] §3.1 移动完成、host-hub 与 gateway 零残留副本（grep 核查）；hub-protocol 零 @x-harness 依赖
- [ ] §4.2/4.3/4.4 API 与语义逐条（含 id 守卫、行超限本地拒、exit 三步、close/kill）
- [ ] §4.5 观测面全量字段 + log/onRawLine 缝 + 心跳透传；消费端可零改接入自家 metrics
- [ ] §4.7 pool 语义逐条（去重/清槽/TTL/evict/聚合）
- [ ] §7 测试口径全绿（单元/契约/封闭性三层）；回归用例带症状命名
- [ ] §8 预算逐条：定时器 ≤2 常驻、行缓冲 16MiB、pending 稳态归零断言
- [ ] 四门全绿 + 覆盖率数字如实报告（新包计入 packages/* 分母，阈值 90/85 不动）
- [ ] 对抗审查（契约/并发密集批次逐批 + 本文档定稿前一轮）问题清零
- [ ] host-hub 装置迁移后其全量测试绿；gateway 测试绿
