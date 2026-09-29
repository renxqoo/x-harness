# 02 · 总体架构

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；事实基线：[01](01-context.md)

## 1. 分层与依赖方向

```
                     ┌───────────── 消费端 ─────────────┐
                     │ web 服务端(多用户)   cli(未来)    │
                     └──────────────┬───────────────────┘
                                    │ createHubPool / connectHub
                     ┌──────────────▼───────────────────┐
                     │ packages/hub-client（SDK 本体）   │
                     │ pool │ connect │ process │ core  │
                     └──────────────┬───────────────────┘
                                    │
                     ┌──────────────▼───────────────────┐
                     │ packages/hub-protocol（契约单源） │ ← 零依赖（node 内置除外）
                     └──┬──────────┬──────────┬─────────┘
                        │          │          │
             host-hub ──┘ gateway ─┘ relay* ──┘（gateway 消费造帧/分类；relay 见 §4）
```

**不变量**（逐条可机械检查）：

- **I1 hub-protocol 零 @x-harness 依赖**（package.json dependencies 为空；仅 node 内置）
  ——host-hub、hub-client、gateway 共同底座；
- **I2 host-hub 不依赖 hub-client**（被 spawn 方不依赖 spawn 方——否则测试图成环）；
- **I3 hub-client core 不 import node:child_process**（传输无关；进程语义只住 process
  传输层）；
- **I4 hub-protocol 不进内核组**：`scripts/check-kernel-deps.ts` 只把 `packages/core/*`
  与 `packages/permission/*` 当内核组扫描，`packages/hub-protocol` 落平铺层天然不在
  KERNEL_GROUP 允许集——内核组 import 它即报 upper-layer 违规，无需改脚本。

依赖方向图（新增边）：

```
hub-protocol ← hub-client ← (未来) web 服务端 / cli
hub-protocol ← host-hub（导入翻转，删原件）
hub-protocol ← hub-gateway（fanout 换导入，删镜像）
```

## 2. 与既有分包先例对齐（工程事实）

remote-protocol / remote-client 是直接样板（[01 §2](01-context.md) 同款事实核对）：

| 维度 | remote 先例 | hub 本方案 |
|---|---|---|
| 包形状 | `exports: {".": "./src/index.ts"}`、private、workspace:* | 同 |
| 协议包依赖 | 零 dependencies | 同（I1） |
| 客户端包依赖 | 仅 `@x-harness/remote-protocol: workspace:*` | 同（hub-client 仅依赖 hub-protocol） |
| 测试组织 | `src/__test__/` 与源文件同名对置（protocol）/按主题（client） | 同（[07 §2](07-testing.md)） |
| 构建形态 | 源码直出（bun 跑 TS，无 per-package build） | 同——根 build script 不动 |
| 覆盖率 | 计入 packages/* 分母（index.ts 除外） | 同——新包自动计入，阈值 90/85 不动 |

## 3. 设计原则

1. **单一真相**：帧构建/分类、命令词表、错误码、行上限、分帧器各只有一份，住
   hub-protocol；host-hub 原件删除、gateway 镜像删除，不留别名不留双轨（过渡规则见
   [08 §3](08-implementation.md)）；
2. **薄而不蠢**：SDK 不复验 host 侧校验（unknown command 由 host 拒）、不缓存 host
   状态、不做命令语义——只做进程生命周期、对账、分发、观测；
3. **策略注入**：重启、重试、metrics、日志、空闲回收全部是注入缝，库内零策略；
4. **如实失败**：传输层失败合成同构 response 并在 exit/stats 留下事实，不吞不折平。

## 4. relay 与 hub-protocol 的关系（边界澄清）

hub-relay 当前只依赖 `@x-harness/remote-protocol`（gateway↔relay WS 链路），**不消费
host 帧契约**——host 帧在 gateway 处已被 host-ingest 转成 remote Frame。因此本期
relay 不接入 hub-protocol；入口图的 relay 边是「未来传输扩展时可接入」的占位，
不构成本期验收项（防止审查时误判为范围蔓延）。

## 5. 单写者纪律（线程模型）

- SDK 全部状态在单事件循环内（Node/Bun 单线程假设，与 host-hub/worker 同款）；
- stdout 泵是唯一帧入口：单 listener 顺序 feed 分帧器 → 顺序分发（response 结算 →
  事件回调），天然全序；
- 无锁、无条件变量；「并发安全」由全序分发 + Map 单写者保证。

## 6. 并发/一致性预算（数字化硬约束，违反 = 缺陷）

| # | 预算 | 值 | 依据 |
|---|---|---|---|
| B1 | 常驻定时器 | **≤ 2**/连接 + pool ≤ 1/池：心跳死线检查 1s 间隔 × 1 + pool 回扫 30s × 1（池级，非每槽） | 对齐 gateway host-attach 现状（单 interval）与 host 心跳 1Hz |
| B1' | 定时器/句柄生命周期 | 死线 interval、回扫 interval、子进程 stdio 管道句柄全部 **unref**（不钉住消费进程事件循环）；kill/close 宽限定时器在进程退出时即清；**消费进程退出前必须 close/kill**（包 README 明示：未关的 hub 句柄 + 未 unref 的 stdio 管道会阻止进程退出——unref 后主动退出不再受阻，但孤儿 host 进程仍在——README 给出「退出前 closeAll」纪律） | CLI 形态「干完活退不出/孤儿 host」的双向防护 |
| B2 | 每在飞呼叫超时定时器 | 1，**结算即清**，稳态 0 | D4 |
| B3 | 行缓冲内存上界（收侧） | ≤ 16MiB + 1 行/连接（分帧器字节域定界，超限即弃） | CLIENT_LINE_LIMIT |
| B3' | 发送侧排队上界 | 单连接在飞发送字节 ≤ maxSendQueueBytes（缺省 64MiB，可注入）：背压排队累计超限 → 新 call 本地拒（protocol, "send queue full"）；另注：16MiB 级行的发送瞬时峰值 ≈ 3-4×（原对象 + stringify 串 + 拼接副本 + write 编码 Buffer），属突发峰值非稳态驻留 | Node writable 无内背上界 + pending 无硬上限的真空填充；消费端可按需收紧 |
| B4 | 事件缓存 | **0**（无 replay buffer——SDK 是热消费；replay 是 gateway/remote 层职责） | 单一真相：gateway OutboxStream 已存在，不复制 |
| B5 | pending 表上界 | Map 无硬上限；host 侧 PENDING_COMMANDS_CAP=65_536 是真闸门；SDK 侧泄漏检测 = 稳态 `stats().pending` 归零断言 | host 闸门 + 观测兜底 |
| B6 | 回调内禁 IO | SDK 自身事件回调路径无 IO（log 缝异步 fire-and-forget 除外）；消费端回调阻塞会背压帧分发——同步分发的如实代价，记入包 README | 同步全序的代价显式化 |
| B7 | 单帧分发耗时 | 事件回调前的工作（parse/classify/查表）O(line)；分帧器**收整帧重写**：不再逐 chunk Buffer.concat 全量拷贝（现状 jsonl.ts:47 对 16MiB 行 × 64KB chunk ≈ 2GiB 累计 memcpy，堵事件循环喂养 B6 死线误杀）——SDK 侧泵用 chunk 链式缓冲（攒 chunk 引用 + 偏移切行，行为与 createJsonlSplitter 逐字节等价，契约测试对拍）；分帧器本体留在 hub-protocol 原样（host 侧自用它没有多连接放大面），SDK 的等价实现同文件对外导出共用 | 恶劣输入下不放大；单源纪律以对拍测试保等价 |

## 7. 传输扩展点（未来，不在本期）

`transport.ts` 纯接口（send/onLine/closed/kill，见 [04 §6](04-hub-client-sdk.md)）。
未来远程形态 = 新增传输实现文件（如 remote-transport.ts 挂 relay 链）+ connect.ts
加装配分支；core/events/stats/pool 零改动——这是 core 不 import child_process 的回报。
协议版本策略：client↔host 无版本握手（帧分类是字节级前缀事实）；同仓 monorepo、
private 包锁步发版，无跨版本兼容承诺；消费端与 host 的版本对齐由部署保证（记入包
README）。不发明版本协商。

## 8. 错误处理哲学（全库统一）

- 业务失败（host 应答 success:false）：返回值分支，error 字段是 HubErrorShape；
- 传输失败（超时/退出/死线/写失败/超限/已 close）：**合成同构 response**，
  `error = { code:"protocol", message:"hub-client: <事实>" }`——与 host 的
  "worker died"/"shutting down" 同族，错误码表不扩项；
- 消费端区分「host 拒了」与「连接断了」：`exit` 事件 + `stats()` 计数
  （callsTransportFailed vs callsBusinessFailed），message 前缀 `hub-client:`；
- 垃圾输入降级不崩：parse 失败的行按 unknown 分类丢弃+计数（host 侧同款纪律）。
