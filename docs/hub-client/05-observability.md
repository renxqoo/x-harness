# 05 · 观测面与类型面

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；SDK API：[04](04-hub-client-sdk.md)；组网：[06](06-pool-multiuser.md)

## 1. 观测面设计立场（D8）

库不绑任何 metrics 实现（Prometheus/OTel/日志栈全部是消费端选择）；SDK 提供四块
**事实出口**，消费端零改代码即可接自家体系：

1. `stats()` 拉模型快照（本节 §2）——定时刮取映射 counter/gauge；
2. `log` 注入缝（§3）——生命周期事件的结构化日志；
3. `onRawLine` 调试缝（§4）——双向原始帧钩子（默认关闭零开销）；
4. 心跳透传（§2 lastHeartbeat* 字段 + on("heartbeat")）——进程级健康锚点。

## 2. HubStats 快照（stats.ts；口径逐字段钉死）

```ts
export interface HubStats {
  connectedAt: number;               // epoch ms（ready 时点）
  hostPid: number | null;
  callsTotal: number;                // = 发起的 call 总数（含本地拒与合成失败）
  callsBusinessFailed: number;       // host 应答 success:false（host 拒了）
  callsTransportFailed: number;      // 合成 failure：超时/退出/死线/写失败/超限/关闭后
  timeoutsTotal: number;             // 超时结算累计（callsTransportFailed 子集）
  pending: number;                   // 当前在飞（泄漏检测：稳态应归零）
  lateResponsesTotal: number;        // 结算后晚到/重复 id 丢弃累计
  malformedFailures: number;         // success:false 且 error 形状非法的结算累计
  protocolFailures: number;          // 无 id parse failure 帧累计（host 侧坏命令事实）
  unknownFramesTotal: number;        // classifyHostLine 落 unknown 的行累计（02 §8 丢弃+计数的落地字段——协议版本错配观测锚点：新帧类型遇旧分类器在此显形）
  parseErrorsTotal: number;          // JSON.parse 失败行累计（SDK 侧坏帧——与 protocolFailures 分立，消三义）
  oversizeDroppedTotal: number;      // 收侧超限行丢弃累计（与 oversizeRejectedTotal 发侧本地拒分立）
  sentLines: number; recvLines: number;
  sentBytes: number; recvBytes: number;   // 含本地拒前序列化字节；不含心跳（host 自发）
  oversizeRejectedTotal: number;     // 16MiB 本地拒累计
  eventsTotal: number;               // 分发给回调的 event 帧累计
  framesByKind: Record<HostFrameKind, number>;  // 收侧帧种类分布（heartbeat/ui_request/hub_error/unknown 等各计数——审批速率/hub_error 频次直接可答，不必开 onRawLine）
  handlerErrorsTotal: number;        // 回调抛错进 onHandlerError 累计
  lastHeartbeatAt: number | null;    // 最近心跳帧 epoch ms
  lastHeartbeatRssBytes: number | null;
  lastHeartbeatCpuPercent: number | null;
  deadlinesTotal: number;            // 心跳死线累计
}
```

口径细则：

- **计数器单调**（除 reset）；快照是**只读深拷贝**（外部改不动内部——契约测试断言）；
- `reset()`：全部归零、connectedAt 重打——语义是「重新观察」不是「否认历史」，
  供消费端周期采样对齐（**消费端亦可用两次快照 diff 达同效——reset 是便利不是必需**）；**pending > 0 时 reset 拒绝**（返回错误结果不静默）——
  在飞呼叫的 callsTotal 已计入旧账，结算只加 business/transport 分母侧，静默 reset
  会永久打破守恒；
- `callsTotal = callsBusinessFailed + callsTransportFailed + 成功数`（守恒断言进测试）；
- bytes 口径：`sentBytes` 计 JSON.stringify 后的行字节（含被本地拒的——先序列化
  才能判超限）；`recvBytes` 计分帧器吃进的原始 chunk 字节。

## 3. log 缝（生命周期结构化日志）

```ts
log?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void
```

事件清单（message 词表封闭，fields 结构固定）：

| message | level | fields |
|---|---|---|
| spawn | info | hostBin, agentDir, pid |
| ready | info | pid, elapsedMs |
| exit | info | code, reason, uptimeMs |
| deadline | warn | heartbeatDeadlineMs, lastFrameAt |
| call_completed | info | id, command, elapsedMs（成功侧单据——慢/丢呼叫按 id 对账） |
| call_failed | warn | id, command, reason(business:<code>/transport:<事实>)——host 应答 success:false 与合成失败双侧 |
| call_failed_local | warn | id, command, reason(oversize/closed) |
| handler_error | error | kind, error(String) |

纪律：**敏感字段不落日志**——env（可能含 key）、args 原文（可能含用户消息）不进
fields；log 回调自身抛错吞掉（log 失败不能影响主路径）+ stderr 一行兜底。

## 4. onRawLine 调试缝

```ts
onRawLine?: (line: string, dir: "in" | "out") => void
```

- in = 从 host 收到的行（分帧后、parse 前）；out = 发向 host 的行（含合成失败前的
  序列化结果；本地拒的行也回调——dir="out" 但未写管道，调试需要看到）；
- 默认 undefined 零开销；回调抛错进 onHandlerError；回调阻塞会同 B6 一样背压帧
  分发（并可能触发死线误杀防护链）——生产开启需自限回调耗时（README 同步警告）；
- **脱敏口径**：auth/set_api_key 的 out 行**内置打码**（§6——判定依据 = 呼叫侧
  command 上下文（pending 表/序列化前对象），key 值掩 `***`、id/形态保留；本地拒
  行无 call 上下文，按序列化串前缀命令字段嗅探同款打码）；**其余命令不做脱敏**
  ——帧内含用户消息，README 警告生产默认关闭、按连接粒度开启。

## 5. CommandResponses 类型面（command-types.ts，D9 增量标注）

```ts
export interface CommandResponses {           // 第一批（高频 + 服务端组网必需）
  "thread/list": { threadId: string; cwd: string; sessionPath: string | null; state: "live" | "parked" | "dead"; idleMs: number; rssBytes: number | null; keepalive: boolean; isStreaming: boolean; gitBranch?: string }[];  // handler 内联（host-commands.ts:273-289；state 归一：spawning/retiring→live）
  "thread/list_saved": { sessions: SavedSession[] };   // saved-query.ts SavedSession
  "get_host_info": { errorCodes: string[]; threads: unknown[]; limits: Record<string, unknown>; [k: string]: unknown };  // 形状锚 host-commands.ts:324-341——契约测试对拍后收窄（前向内联，避免幽灵类型名）
  "get_models": { id: string; provider: string; contextWindow?: number; maxTokens?: number; reasoning: boolean; input?: ("text" | "image")[]; cost?: unknown; source: string }[];  // modelShapeOf 输出（models-auth.ts:63-75,132-140），数组直出非 {models} 包装——非 CatalogEntry
  "agents/list": { agents: { name: string; description: string; source: "builtin" | "user" | "project"; model?: string }[] };
  "skills/list": { skills: ... };             // admin-commands.ts:210
  "plugins/list": { plugins: ... };           // admin-commands.ts:267
  "settings/get": { values: HubSettings } | { values: HubSettings; sources: ...; raw: ... };  // 判别键 = args.cwd（admin-commands.ts:115-138）：无 cwd → {values}；有 → {values,sources,raw}
  "auth/list": { providers: { provider: string; type: string }[] };   // models-auth.ts:149
  "get_state": { ...双来源形态 };            // live: worker-read-commands.ts:14-30；parked: read-history.ts:65-84（sessionFile 拼法不同）——契约测试分别对拍两形态
}
// 入参类型 = hub-protocol 键控映射 InputOf<K>（03 §1 commands.ts 内定义、随词表同提交——非 hub-client 重声明，镜像由 C7 拦）
export type CommandArgs<K extends CommandName = CommandName> = InputOf<K>;
// 命令族超时缺省（命令的客观属性，SDK 侧单源——消费端不再各自编码清单）
export interface CommandTimeouts {
  "bash": 610_000; "thread/resume": 90_000; "thread/start": 90_000;
  // 增量随 CommandResponses 标注同流程登记（03 §6）；键 ⊆ CommandName 受 C7 门禁
}
// 优先级（单源裁决）：opts.timeoutMs > CommandTimeouts[command] > callTimeoutMs 缺省
```

纪律：

- **标注不是验证**：wire 真源在 host 处理器；契约测试（script 装置）抽样断言字段形状
  防漂移（[07 §3](07-testing.md) 表驱动命令抽样）；
- 增量演进：新命令先落 unknown（宽型 call 签名），有真实消费端再标注——防止拍脑袋
  发明类型；
- `get_models` 是**数组直出**（非 `{models: [...]}` 包装）——与旧文档草案的差异已按
  代码事实修正，契约测试对拍钉住。

## 6. 消费端接入模式（包 README 内容底稿）

- **超时映射清单（必读）**：网关/LB 超时（典型 30s）< SDK 缺省 60s 时，网关先断、
  SDK 仍在飞、客户端重试 → prompt 双发——**SDK callTimeoutMs 必须小于上游超时**；
  **SDK 已给命令族缺省**（§5 CommandTimeouts：bash/thread/resume/thread/start——
  消费端零动作）；**仍需消费端显式评估**：compact、plugins/install 系（尚未入
  CommandTimeouts 前的窗口）、上游超时 < SDK 缺省时的整体收紧（callTimeoutMs 调低）；
  驱动族（prompt/steer/follow_up）的 call 超时只覆盖「受理」——完成事实按 settled
  等待（06 §3），不要用 call 超时当 turn 超时；
- **Prometheus pull 型**：定时刮 hub.stats()（或 pool.stats() 聚合，见 06 §3）映射
  自家 counter/gauge；告警锚点：callsTransportFailed 增速（连接病）、pending 稳态
  非零（泄漏）、deadlinesTotal（host 卡死）、lastHeartbeatRssBytes（内存趋势）；
  **基数警告**：不要按 userId 直接打 label（无界基数打爆 TSDB + 用户清单入监控
  PII 面）——按租户/分桶聚合，明细按需拉单 hub stats；pool.stats() 千 key 深拷贝
  成本：采样频率与用户量乘积自限（千用户 15s 刮档可接受）；
- **日志**：log 缝接消费端 logger（结构化 fields 直映 JSON line）；**呼叫级可归因**：
  成功路径也有 call_completed 事件（fields: id, command, elapsedMs——无 args 原文），
  慢/丢呼叫可按 id 对账（wire 冻结无 trace 透传，id 是唯一关联键）；
- **trace/调试**：onRawLine 双向帧钩子 + onHandlerError 兜底；**凭据帧脱敏（内置）**：
  command 为 auth/set_api_key 的 out 行在 onRawLine 回调前打码（key 值掩 ***，
  id/形态保留）；按连接粒度开启（生产默认关）；
- **健康检查**：stats().lastHeartbeatAt 距今 + pending 是就绪/积压探针的两块事实
  （不发明「健康布尔」——事实由消费端解释）；**停机窗口注**：close/kill 宽限内
  host 心跳已停（01 §2.6），探针必然变红——探针应叠加 exit 状态（exited 未
  resolve = 关闭中，摘流不告警）；
- **凭据生命周期（BYO key 服务端必读）**：host 把凭据落 <agentDir>/credentials.json
  （0600，同 uid 可读）；pool 的 evict/closeAll 只关进程**不清盘**——用户注销/
  密钥轮换的磁盘清理归服务端（生命周期条目挂用户账号）；多节点共享存储下凭据
  随目录同步扩散——06 §5.1 P2 的 OS 层隔离是前提不是可选项。
