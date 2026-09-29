# 01 · 背景、事实与裁决

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)（入口：导航/总裁决/审查记录）

## 1. 背景：三个客户端形态证明需求真实

host-hub 暴露 JSONL 进程协议（stdin 命令 / stdout 帧）。契约目前住在 host-hub 内部
（`protocol/` + `shared/`），没有任何宿主能以「库」形态驱动 host-hub：

| 存在形态 | 位置 | 现状 | 缺陷 |
|---|---|---|---|
| gateway host-attach | `apps/hub-gateway/src/host-attach.ts` | spawn + 心跳死线 + kill&restart | restart 语义耦合 gateway；kill 宽限 2s 硬编码；无对账（gateway 自建 pendingByHostId） |
| 测试装置 | `apps/host-hub/src/__test__/kit/host-client.ts` | 19 个测试文件消费 | 测试专用、无类型面、不导出、行解析不带超限处理 |
| remote-client | `packages/remote-client/src/connect.ts` | relay 远程链路 | 面向 WS/relay，非本机进程形态；自带重连/重发语义 |

同时 `apps/hub-gateway/src/fanout.ts:6` 的 `classifyHostLine` 是 host 帧分类的**本地镜像**
（与 host-hub `frame-classify.ts` 各自维护），契约无法被外部单源引用。

## 2. 协议面存量事实（file:line 锚定，2026-09-29 核对）

### 2.1 命令词表

`apps/host-hub/src/protocol/commands.ts:53` `COMMAND_NAMES` 封闭集。成文时 80 项
（thread/notify 在途合入：`git diff apps/host-hub/src/protocol/commands.ts`）。
分四域（域判定依据：`host-commands.ts:370-391` handlers 注册表、`admin-commands.ts:114-357`、
`parked-reads.ts:6`、`internal.ts:19-81` 三集合）：

- **host 本地**（约 41）：host-commands 直注册 19（thread/start/resume/register/stop、
  thread/delete/retire/set_keepalive、thread/list、thread/list_saved、get_models、
  set_model_override、auth 三命令、agents/list、get_host_info、两个旋钮、ui_response）+
  admin-commands 22（settings/skills/plugins/models/agents 管理面、workspace/trust）；
- **parked/dead 直读**：PARKED_DIRECT_COMMANDS = {get_state, get_entries, get_inflight,
  get_subagents, get_pending_dialogs}（`apps/host-hub/src/host/parked-reads.ts:6`）——
  host 直读盘应答免唤醒 worker；permission/set_mode、permission/get_mode 双形态
  （parked 时 host 应答、live 时交池，`admin-commands.ts:79-112`）；
- **线程域**：THREAD_SCOPED_COMMANDS 38 项（`apps/host-hub/src/protocol/internal.ts:19`）
  转发 worker；含 DRIVING_COMMANDS = {prompt, steer, follow_up}（`internal.ts:81`）；
  thread/start/resume/stop/register 同时也在 host handlers 注册（受理/门控层）——
  域是路由属性不是互斥分区；
- **host 中继线程命令**：HOST_RELAYED_THREAD_COMMANDS = permission 五命令
  （`internal.ts:60`）——host 改写后广播 live worker。

另：LIVE_ONLY_COMMANDS = {thread/notify}（`internal.ts:86`，非 live 态拒 thread_not_live）
是 host 路由门私有；worker→host 侧另有 OBSERVER_COMMANDS 16 项（不重置 worker idle
计时，`worker.ts:202`）。

入参形状类型：CommandInput、ThreadStartSpec、PromptSpec、SteerSpec、EntriesQuery、
ForkSpec、BashSpec（`commands.ts:3-51`，纯类型无运行时消费方）；WireImage（`shared/images.ts`）。
另注：`packages/remote-protocol/src/vocab.ts` 的 HOST_COMMAND_MATRIX 只有 60 条，
缺 20 条新命令（thread/notify、plugins/*、workflow/*、permission/grant 族等）——
gateway 词表镜像的漂移事实，与本方案的契约单源动机同源（gateway 侧修复属 remote
面专项，不在本期范围）。

### 2.2 错误码

`apps/host-hub/src/shared/errors.ts:1` HUB_ERROR_CODES **26 项**（此前文档误记 31，
已核对）。HubErrorShape `{code, message}`、isHubErrorShape 守卫、CodedError、
errorOfCause 同文件。

### 2.3 帧形态与 key 序（wire 契约核心，逐字节不动）

`apps/host-hub/src/protocol/frames.ts` 七个构建器：

| 帧 | 首键 | key 序 |
|---|---|---|
| response | `"id"`（恒首） | id, type, command, success, [data \| error] |
| event | `"type"` | type, threadId, name, payload, [agentName] |
| ui_request | `"type"` | type, requestId, threadId, method, …payload |
| heartbeat | `"type"` | type, rssBytes, cpuPercent |
| hub_error | `"type"` | type, message, [threadId] |
| thread_died | `"type"` | type, threadId, reason |
| thread_parked | `"type"` | type, threadId, reason |

response 头正则（`shared/frame-classify.ts:10`）锚定 `id` 恒首 + `type: "response"` 第二
——**id-first 是 response 独有形态**，其余帧 type-first。gateway 镜像
`fanout.ts:6` 用前缀 startsWith 分类，覆盖同集。

### 2.4 host 内部命名空间（客户端不得冒充）

`apps/host-hub/src/protocol/internal.ts:3` `INTERNAL_ID_PREFIX = "@hub-internal:"`；
host 侧 routeGateFailure 对该前缀 id 拒绝（`apps/host-hub/src/host/worker-pool.ts:381`）。
另有 `@pending-` 前缀（worker-pool.ts:295）是 host 内部 threadId 槽位名。**HelloFrame/
WorkerHeartbeat/WORKER_PROTOCOL_VERSION 是 host↔worker 私有握手**（`worker-frames.ts:33`），
客户端永不见——不进 hub-protocol。

### 2.5 分帧器

`apps/host-hub/src/shared/jsonl.ts` createJsonlSplitter：LF 唯一分隔、容忍尾 `\r`、
超限（CLIENT_LINE_LIMIT=16MiB，`shared/limits.ts:10`）恰报一次并丢弃该行、空行跳过、
flush 残留。client↔host 双侧同源（host.ts:179、worker.ts:197 各挂一个实例）。

### 2.6 生命周期与对账（host 侧事实）

- **受理对账**：host 命令路由「有 id 必回 response」——受理即回（success:true/false
  data/error），`worker-pool.ts` pendingCommands 表（id→command）管理在飞；
  PENDING_COMMANDS_CAP=65536 满时 emitFailure(thread_limit)（`worker-pool.ts:250`）；
- **worker 死亡结算**：slot.pendingIds 全部合成 `protocol "worker died before responding"`
  failure；drivingIds（prompt/steer/follow_up）额外发 `settled` 事件 `{sendId, ok:false,
  reason:"worker-died"}`（`worker-pool.ts:73-82`）；
- **shutting down**：host 关机中收到命令回 `protocol "shutting down"`（`host.ts:197`）；
- **parse failure**：坏 JSON / 超限回**无 id** response `command:"parse"`（`host.ts:185,193`）；
- **心跳**：host 进程 1Hz（`host.ts:66-71`）`{type:"heartbeat", rssBytes, cpuPercent}`；
- **EOF 优雅停机**：stdin end → shutdown()：sweep/gitWatch 停、心跳停、
  pool.shutdownAll()（worker eof + 宽限 SIGTERM + 30s 等待）、writer.idle() 冲刷、
  exit(0)（`host.ts:159-169,212-214`）；
- **SIGTERM/SIGINT**：同 shutdown 路径（`host.ts:171-176`）；
- **stdout 断管**：takeOverStdout onBroken → shutdown（`shared/stdout-guard.ts`、
  `host.ts:48-53`）。

### 2.7 容量与调度（host 内建，SDK 透传不复制）

maxThreads 缺省 32（env HUB_MAX_THREADS）；超发 `thread_limit "too many live threads"`；
idleRetireMs 缺省 900_000（15min，`set_idle_retire_ms` 可调，clamp [1s,24h]）；
rssRetireBytes 0=关；workerStale 30s；workerExitTimeout 10s；bashTimeout 600s
（`shared/limits.ts:58-67`）。thread/start 的响应（`host-commands.ts:124`）是**受理**
（beginThread 成功即 `success:true`），threadId 由后续 `turn/start` 事件送达——
**受理 ≠ 完成**（见 04 §5 二段性）。

### 2.8 ui_request 往返

worker 侧 dialog broker（`apps/host-hub/src/worker/dialogs.ts`）：requestId=randomUUID、
method="confirm"、payload 白名单滤保留键；resolve 收 `{verdict:"allow"|"deny"}` 或
`{confirmed:boolean}`（两代形态并存）；confirmTimeoutMs=300s 超时按 deny 结算；
denyAll 在 shutdown 时兜底。ui_response 由 host 空应答 ack 转发 worker
（`host-commands.ts:367,389`）。

### 2.9 鉴权/凭据事实

agentDir = `HUB_AGENT_DIR` env 或 `~/.x-harness/hub`（`host/cli.ts:6`）；
sessionsRoot = `HUB_SESSIONS_ROOT` 或 `<agentDir>/sessions`（`cli.ts:11`）；
凭据 `credentials.json` 600 权限（`host/credentials.ts`）；trust 注册表
`trusted-workspaces.json`（`host/trust-store.ts`）；**trustedCwds = 注册表 ∪ live 线程
trusted cwd 并集**（`host/admin-commands.ts:42-49`）——共享 host 跨租户下是泄漏面。

### 2.10 契约测试现状（迁移基线）

- `contracts-frames.test.ts`：词表封闭性（四集合 ⊆ 词表、驱动⊂线程域、观察者⊂线程域∪
  白名单、白名单∩线程域=∅）+ key 序往返对拍（含转义 id、无 id parse 形态）；
- 词表数字断言（当前 80）住 smoke.test.ts:85 与 contracts-frames.test.ts:41——
  迁移时随单源走；
- 装置 kit：host-client.ts（真子进程 spawn + 首心跳 ready + 谓词等待器 + stderr 转发）、
  worker-harness.ts（进程内 worker）、pool-fixture.ts（假 spawn 工厂）；
  `HUB_WORKER_PROVIDER=script` 假 worker 机制定义在 `shared/script-adapter.ts:36`
  （ScriptStep 判别联合经 env `HUB_WORKER_SCRIPT` 注入）。

## 3. 目标

1. **方法调用返回 JSON**（U2）：response 帧 parse 后原样返回，零包装零信息损耗，
   业务失败是返回值分支不是异常；
2. **多消费端**：web 服务端（多用户多 session）、cli、hub-gateway、host-hub 自身
   （契约单源消费方）；
3. **契约单源**：帧/词表/错误码/分帧抽为 `@x-harness/hub-protocol`，消灭镜像；
4. **可观测内建**（D8）：stats/log/onRawLine/心跳透传，消费端零改接入自家体系；
5. **可维护**：传输无关核心、封闭性门禁、类型面增量演进（D9）。

## 4. 非目标（归属写清，不留白）

| 不做 | 归属/理由 |
|---|---|
| HTTP/WS 服务 | SDK 是库；服务端由消费端组装（U1 裁决的自然推论） |
| 改 wire 协议 | 帧形态/key 序/错误码/词表逐字节不动——SDK 是既有协议上层 |
| 自动重连/重启 | 消费端（D3；pool.onExit 注入；gateway 自持 kill&restart） |
| 命令级重试 | 幂等性是命令属性（D10：thread/start 重试 already_open、prompt 重试双发） |
| 远程传输（WS/relay） | 后续传输扩展点（[02 §7](02-architecture.md)）；远程端现走 remote-client |
| 79+ 命令 data 全量类型 | 增量演进（[05 §5](05-observability.md)） |
| host 命令处理器行为 | host-hub（本方案只做契约搬家与客户端新增） |
| gateway host-attach 迁移 | 后续专项（D6；本期只消灭 fanout 镜像） |
| ui_response 审批编排 | 消费端（SDK 只透传） |
| 多节点共享存储 | 部署层专项（[06 §7](06-pool-multiuser.md)） |
| 命令合法性复验 | host（unknown_command 单一闸门，SDK 薄而不蠢） |
| 回放缓冲（replay） | gateway/remote 层职责；SDK 是热消费（[02 §6](02-architecture.md) 预算） |

## 5. 用户裁决（U 表）

| # | 裁决 | 出处 |
|---|---|---|
| U1 | SDK = host-hub **子进程客户端**（spawn + 方法调用走既有 JSONL 协议），不是把 host 实现搬进库函数 | 2026-09-29 |
| U2 | 方法调用**直接返回 JSON**（response 帧 parse 后原样返回），任何消费端通用 | 2026-09-29 |
| U3 | 多用户多 session 首要场景：**用户 → host 进程（隔离单元），session → thread（并发单元）**；跨租户每用户一根 host，同租户多 session 共享 host 多 thread | 2026-09-29 |

## 6. 默认裁决（D 表，否决窗口内可改）

| # | 裁决 | 理由 |
|---|---|---|
| D1 | 包位置 `packages/hub-protocol` + `packages/hub-client`（非 apps/） | 库被 apps 依赖；与 remote-protocol/remote-client 分包先例一致；依赖方向干净（host-hub 不得依赖「spawn 它的客户端」） |
| D2 | `call()` 永不 reject；业务失败 = success:false 分支；传输失败 = 合成同构 response（code=protocol） | HTTP handler 等消费端不需要 try/catch 包一层；错误码表不扩项 |
| D3 | 不自动重启：暴露 exited + exit 事件 + close()/kill()；重启策略归消费端 | gateway 现有 kill&restart、web 服务端重建策略语义不同，库不该持策略 |
| D4 | 呼叫超时缺省 60s，逐呼叫 timeoutMs 覆盖（0/Infinity 关闭）；超时结算后晚到响应丢弃+计数 | bash/长命令由调用方显式放宽；晚到不复活已结算 promise |
| D5 | 命令面只做通用 call(command, args?) + 类型映射表，不手写 79+ 个方法糖 | vocab 单源在 hub-protocol；命名糖等真实用量后增量（防止拍脑袋发明名字） |
| D6 | gateway host-attach 整体迁移不在本期；只消灭 fanout 帧分类镜像 | 控制爆炸半径；镜像消灭已拿全契约单源收益 |
| D7 | createHubPool 池化组件进包（纯逻辑、工厂注入、无重启策略） | 每个服务端消费端都要写；并发去重/退出清理/空闲回收细节易错；纯逻辑可全单测 |
| D8 | 观测面 = stats() 拉模型 + log 缝 + onRawLine 缝 + 心跳透传；不绑任何 metrics 实现 | 消费端接 Prometheus/日志/trace 自由；库零依赖噪音 |
| D9 | response data 类型增量标注：第一批高频命令，映射表可扩充；未标注命令 data 落 unknown | 类型住 hub-client（wire 真源仍 host 侧），契约测试抽样对拍；全量一次性标注不可持续 |
| D10 | 不内置命令重试 | thread/start 重试会 already_open、prompt 重试会双发——幂等性是命令属性；降级重试归消费端按错误码语义 |
| D11 | 池空闲回收策略注入（idleTtlMs 缺省 0=不回收）；无引用计数 | web 形态 hub 长驻于用户会话而非单请求，TTL 兜底 + 管理面显式 evict 足够 |

## 7. 术语表

| 术语 | 定义 |
|---|---|
| 帧(frame) | stdout 一行一个 JSON 对象；七类 + unknown |
| 受理(accept) | host 对有 id 命令回 response 的第一段：表已登记/命令已投递 |
| 完成(completion) | 第二段：命令实际效果的事实（事件流，如 settled、turn/start） |
| pending | SDK 侧已发未结算的呼叫表（id → {command, settle, timer}） |
| 心跳死线 | 超过 heartbeatDeadlineMs 无任何 stdout 帧（不只 heartbeat；01 §7 术语口径以此为准）判 host 失活；close/kill 进行中悬挂 |
| 槽位(slot) | pool 内 key → hub 句柄的占用格 |
| 驱动命令 | DRIVING_COMMANDS：prompt/steer/follow_up（settled 事件配对） |
| 直读 | PARKED_DIRECT_COMMANDS：host 免唤醒直读盘应答 |
