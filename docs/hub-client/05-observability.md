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
  sentLines: number; recvLines: number;
  sentBytes: number; recvBytes: number;   // 含本地拒前序列化字节；不含心跳（host 自发）
  oversizeRejectedTotal: number;     // 16MiB 本地拒累计
  eventsTotal: number;               // 分发给回调的 event 帧累计
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
  供消费端周期采样对齐；**pending > 0 时 reset 拒绝**（返回错误结果不静默）——
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
| call_failed_local | warn | id, command, reason(oversize/closed/dup_id) |
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
- **不做脱敏**——这是调试缝不是审计缝，README 显式警告勿在生产默认开启（帧内含
  用户消息与可能的凭据）。

## 5. CommandResponses 类型面（command-types.ts，D9 增量标注）

```ts
export interface CommandResponses {           // 第一批（高频 + 服务端组网必需）
  "thread/list": ThreadListEntry[];           // 形状锚 host-commands.ts handleThreadList
  "thread/list_saved": { sessions: SavedSession[] };   // saved-query.ts SavedSession
  "get_host_info": HostInfo;                  // host-commands.ts:324-341（errorCodes/threads/limits/...）
  "get_models": CatalogEntry[];               // 数组直出（models-auth.ts:140），非 {models} 包装
  "agents/list": { agents: { name: string; description: string; source: "builtin" | "user" | "project"; model?: string }[] };
  "skills/list": { skills: ... };             // admin-commands.ts:210
  "plugins/list": { plugins: ... };           // admin-commands.ts:267
  "settings/get": { values: HubSettings } | { values: HubSettings; sources: ...; raw: ... };  // 形态随入参 scope
  "auth/list": { providers: { provider: string; type: string }[] };   // models-auth.ts:149
  "get_state": GetStateResponse;              // worker-read-commands.ts:14-30
}
export interface CommandArgs { /* 同法挂同名键；入参形状已在 hub-protocol commands.ts 单源 */ }
```

纪律：

- **标注不是验证**：wire 真源在 host 处理器；契约测试（script 装置）抽样断言字段形状
  防漂移（[07 §4](07-testing.md)）；
- 增量演进：新命令先落 unknown（宽型 call 签名），有真实消费端再标注——防止拍脑袋
  发明类型；
- `get_models` 是**数组直出**（非 `{models: [...]}` 包装）——与旧文档草案的差异已按
  代码事实修正，契约测试对拍钉住。

## 6. 消费端接入模式（包 README 内容底稿）

- **Prometheus pull 型**：定时刮 `hub.stats()`（或 `pool.stats()` 聚合，见 06 §3）映射
  自家 counter/gauge；告警锚点：`callsTransportFailed` 增速（连接病）、`pending` 稳态
  非零（泄漏）、`deadlinesTotal`（host 卡死）、`lastHeartbeatRssBytes`（内存趋势）；
- **日志**：log 缝接消费端 logger（结构化 fields 直映 JSON line）；
- **trace/调试**：onRawLine 双向帧钩子 + onHandlerError 兜底；
- **健康检查**：`stats().lastHeartbeatAt` 距今 + `pending` 是就绪/积压探针的两块事实
  （不发明「健康布尔」——事实由消费端解释）。
