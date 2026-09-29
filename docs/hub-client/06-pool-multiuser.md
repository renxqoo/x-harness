# 06 · 池化与多用户多 session 组网

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；SDK API：[04](04-hub-client-sdk.md)；隔离事实：[01 §2.9](01-context.md)

## 1. createHubPool（D7/D11）

```ts
const pool = createHubPool({
  acquire: (key: string) => connectHub({ agentDir: agentDirOf(key) }),  // 工厂注入（key=userId 等）
  onExit?: (key: string, info: ExitInfo) => void,   // 重启策略挂点（缺省仅移除槽位）
  idleTtlMs?: number,                               // 空闲回收（缺省 0 = 不回收）
  evictTimerTickMs?: number,                        // 回扫间隔（缺省 30_000）
  now?: () => number,                               // 测试缝
});

await pool.hub("user-42");        // 并发去重（同 key 并发 → 同一 connectHub promise）
await pool.evict("user-42");      // 管理面显式关停（强制下线）：close 后移除槽位
pool.keys(): string[];
pool.stats(): Record<string, { stats: HubStats; lastAcquireAt: number }>;
await pool.closeAll(): Promise<void>;   // 终态停扫 + 清槽（可再 hub 新建；见 §1 细则）
await pool.dispose(): Promise<void>;   // closeAll + 永久关闭（进程退出前收尾）
```

**池职责边界**（防止 scope 蔓延）：

- 只管**槽位生命周期**：并发去重、exited 清槽、TTL 回扫、evict、closeAll、stats 聚合；
- **不管事件路由**：消费端在 `hub()` 返回的句柄上自挂 on()——池不知道事件内容；
- **不管重启**：onExit 注入（消费端可 spawn 新 host + 重建槽位）；池自身在 exit 后
  只做清槽，下次 `hub(key)` 自然重连（懒恢复）；
- **不管连接参数**：agentDir/env 等全部在 acquire 工厂内决定——池对连接形态零知识
  （纯逻辑可全单测的前提）。

语义细则：

- `hub(key)` 并发去重：在飞的 connectHub promise 共享（单 spawn）；**失败的 promise
  不缓存**——下次 hub(key) 重新 acquire（失败槽不粘锅）；hub(key) **命中既有槽时刷新
  lastAcquireAt**（活跃度兼含 call 时刻：任一 call 结算后刷新槽活跃时间，避免
  「缓存句柄长驻使用但从不 hub(key)」的活跃池被 TTL 误收）；
- exit 结算：hub exited → 槽位移除 + onExit 回调；在飞等待者（正 await hub(key)）不
  受影响（各自持有句柄或拿到 reject——connectHub reject 面仅 ready 前）；
- TTL 回扫：`now - 槽活跃时间 > idleTtlMs` 且 `stats().pending === 0` 的槽 → 优雅
  close 移除（**有在飞呼叫不回收**——避免活请求被切断；下轮回扫再试）；
  **回收与 acquire 的窗口防护**：进入回收判定即标记槽为 evicting（新 hub(key) 不命中
  该槽——若需要则重新 acquire 新槽），close 完成后移除标记——消除「回扫判 idle 与
  新 acquire 交错把活请求切成合成 failure」的竞态；idleTtlMs=0 关闭回扫（B1 的 pool
  定时器此时不创建）；
- `evict(key)`：不等 TTL 强制 close（管理面语义）；幂等（无该 key 返回成功）；
  在飞呼叫同样被切断（管理面强制下线的如实代价，README 披露）；
- `closeAll`：快照槽表 → 全部标记 evicting → 并发 close（Promise.allSettled，单个
  失败不阻断其余）→ **停回扫定时器 → 清空槽表**——返回后 pool 处于终态：再
  hub(key) 仍可新建槽（显式重建新池语义，文档明示），closeAll 后回扫定时器不重建
  （idleTtlMs 复用须新建 pool）；`dispose()`：closeAll + 永久关闭（后续 hub(key) 抛
  错误结果）——进程遇出前的确定性收尾面。

## 2. 多用户多 session 组网（U3 落地，参考架构）

**维度拆分**：用户 → host 进程（隔离单元）；session → thread（并发单元）。
host-hub 账本是线程表 + 单 agentDir（凭据/settings/skills/trust 进程共享，
[01 §2.9](01-context.md)）——「用户」边界必须由服务端用进程画：

| 形态 | 适用 | 隔离事实 |
|---|---|---|
| 每用户一根 host | 跨租户 | agentDir/sessionsRoot 全隔离；BYO key 可行；事件天然无跨用户泄漏；崩溃半径单用户 |
| 共享 host 多 thread | 同租户多任务（或 cli 单人） | 一根进程 N thread；凭据/trust 共享——`trustedCwds` 是注册表 ∪ live 线程并集（admin-commands.ts:42-49），跨租户下是泄漏面，**禁用** |

session 是磁盘事实（`<sessionsRoot>/<threadId>/events.jsonl`），活得比进程久：

- 列历史：`thread/list_saved`（host 直读盘，零 worker）；
- 浏览不续聊：parked 态 `get_state`/`get_entries` 等 PARKED_DIRECT 族由 host 直读
  应答（免唤醒）；
- 续聊：`thread/resume`（拉 worker）；新任务：`thread/start`；
- 容量调度用 host 内建：idle retire（缺省 15min，`set_idle_retire_ms` 可调）自动
  park 回收 worker、rss retire 强收编、maxThreads 32 上限（超发 `thread_limit`）——
  稳态 = 每用户一根轻 host + 仅活跃 session 挂 worker。

**并发纪律**：一个 thread 同时只有一个 turn（在飞时 `prompt` 会被 `streaming_window`
拒，worker-commands.ts:215）；服务端按 `userId:threadId` 串行化队列，跨 thread 完全
并行（pending 按 id 对账，天然并发安全）。

## 3. 事件路由（服务端组装面）

- `route(userId, e.threadId)` **两段键拼接才完整**——threadId 只在单 host 内唯一；
- 共享 host 模型下漏按 userId 过滤 = 跨租户泄漏；池形态（每用户一根）结构上免疫；
- 审批 `ui_request`：requestId 是 thread 内一次性令牌（300s 超时按 deny 结算，
  dialogs.ts），回传 `call("ui_response", { requestId, verdict: "allow" | "deny", ... })`；
  消费端应同时监听 settled/超时兜底（host 不保证 ui_request 送达后 thread 还活着）。

## 4. 重启恢复（懒恢复）

服务端重启后用户回来才 `list_saved + resume`，不启动时全量拉起。多节点横向扩
（sessionsRoot 上共享存储的 realpath/fsync 语义）是部署层专项，SDK 不解决不假装
解决（[01 §4](01-context.md) 非目标表）。

## 5. 越权矩阵（安全回归项，测试口径见 07 §5）

多用户服务端必须过越权矩阵（主体 × 资源 × 读路径全维遍历）：

| 攻击向量 | 断言 |
|---|---|
| 用户 A 的 hub 句柄上 call thread/list | 只见 A 的 agentDir 线程（进程隔离结构性保证） |
| A 的事件回调收到 B 的 threadId 事件 | 不可能（A 的 host 只有 A 的线程）——池形态结构性断言 |
| A 用 B 的 threadId call get_state | unknown_thread（B 的线程不在 A 的 host 账本） |
| A 用 B 的 requestId 回 ui_response | host 空 ack（requestId 不在 A 的 worker）无副作用 |
| 共享 host 模式（同租户）跨用户事件 | 服务端 route 过滤层职责——SDK 文档披露 + 不提供假保证 |

结构性免疫（前四行）进 SDK 契约测试；服务端过滤层（第五行）是消费端职责，SDK
README 披露边界。
