# 06 · 池化与多用户多 session 组网

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；SDK API：[04](04-hub-client-sdk.md)；隔离事实：[01 §2.9](01-context.md)

## 1. createHubPool（D7/D11）

```ts
const pool = createHubPool({
  acquire: (key: string, ctx: { bindHub: (h: Hub) => Hub }) => connectHub({ agentDir: agentDirOf(key) }).then(h => ctx.bindHub(h)),  // 工厂注入；ctx.bindHub 由 pool 供出——**pool 自动包一层计活代理**（包装 call 计活——bindHub 是唯一机制，无 onSettled 缝），工厂零转传义务（D12：机制内聚，无人肉契约可漏）
  onExit?: (key: string, info: ExitInfo) => void,   // 重启策略挂点（缺省仅移除槽位）
  idleTtlMs?: number,                               // 空闲回收（缺省 0 = 不回收）
  evictTimerTickMs?: number,                        // 回扫间隔（缺省 30_000）
  // 测试缝（now/timer）不进公共参数面——与 connectHub 同策：经 testing 子出口
  // createTestPool 暴露（TimerHandle 定义随 testing 子出口文档化：{clear,unref}）
});

await pool.hub("user-42");        // 并发去重（同 key 并发 → 同一 connectHub promise）
await pool.evict("user-42");      // 管理面显式关停（强制下线）：close 后移除槽位
pool.keys(): string[];
pool.stats(): Record<string, { stats: HubStats; lastAcquireAt: number }>;
await pool.closeAll(): Promise<void>;   // 清场可复用：停扫 + 清槽，再 hub 随首槽重建回扫（§1）
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
- TTL 回扫：
  `now - 槽活跃时间 > idleTtlMs` 且 `stats().pending === 0` 的槽 → 优雅
  close 移除（**有在飞呼叫不回收**——避免活请求被切断；下轮回扫再试）；
  **turn 活性错位披露（重要）**：prompt 在受理时刻即结算（二段性），活跃 turn
  期间 pending===0——TTL 关停会切断**正在生成的 turn**（settled 永不到达，叠加
  连接换代语义见 §3）与在途 ui_request 审批弹窗（close→denyAll 静默 deny）。
  服务端开 TTL 必须同时：turn 进行中的槽保活（消费端在 turn 期间周期性发
  observer 命令如 get_state 刷新活跃度——池 §1 活跃度定义支持），或 idleTtlMs
  显著大于最长 turn 预算 + evict 前置检查；README 披露该权衡（D11 的代价边界）；
  **回收与 acquire 的窗口防护**：进入回收判定即标记槽为 evicting（新 hub(key) 不命中
  该槽——若需要则重新 acquire 新槽），close 完成后移除标记——消除「回扫判 idle 与
  新 acquire 交错把活请求切成合成 failure」的竞态；idleTtlMs=0 关闭回扫（B1 的 pool
  定时器此时不创建）；
- `evict(key)`：不等 TTL 强制 close（管理面语义）；幂等（无该 key 返回成功）；
  在飞呼叫同样被切断（管理面强制下线的如实代价，README 披露）；
- `closeAll`：快照槽表 → 全部标记 evicting → 并发 close（Promise.allSettled，单个
  失败不阻断其余）→ **停回扫定时器 → 清空槽表**——可再 hub 新建槽且**回扫定时器
  随首槽重建**（语义归一：closeAll = 清场可复用；dispose = 终态——消除「能用但
  静默失去 TTL」中间态）；`dispose()`：closeAll + 永久关闭（后续 hub(key) 抛
  错误结果）——进程退出前的确定性收尾面。

## 2. 多用户多 session 组网（U3 落地，参考架构）

**维度拆分**：用户 → host 进程（隔离单元）；session → thread（并发单元）。
host-hub 账本是线程表 + 单 agentDir（凭据/settings/skills/trust 进程共享，
[01 §2.9](01-context.md)）——「用户」边界必须由服务端用进程画：

| 形态 | 适用 | 隔离事实 |
|---|---|---|
| 每用户一根 host | 跨租户 | agentDir/sessionsRoot 全隔离；BYO key 可行（前提 P2：仅同信任域内成立，见 §5.1）；事件天然无跨用户泄漏；崩溃半径单用户 |
| 共享 host 多 thread | 同租户多任务（或 cli 单人） | 一根进程 N thread；凭据/trust 共享——`trustedCwds` 是注册表 ∪ live 线程并集（admin-commands.ts:42-49），跨租户下是泄漏面，**禁用** |

session 是磁盘事实（`<sessionsRoot>/<threadId>/events.jsonl`），活得比进程久：

- 列历史：`thread/list_saved`（host 直读盘，零 worker）；
- 浏览不续聊：parked 态 `get_state`/`get_entries` 等 PARKED_DIRECT 族由 host 直读
  应答（免唤醒）——**容量事实**：每次直读全量读档 + 逐事件 stringify（上限
  DIRECT_READ_MAX_BYTES=64MiB，read-history.ts，无缓存）；消费端轮询大 session
  （几十 MiB）会给 host 造成秒级同步 CPU 占用——轮询频率与大 session 组合需
  服务端自限（README 披露；SDK 不加缓存——host 行为不属于本方案改动面）；
- 续聊：`thread/resume`（拉 worker；冷启动链 = 最多 12s 让位自旋 + worker spawn
  10s 死线 + session 全量装载 + 握手中继——**SDK 已给命令族缺省 90s（05 §5 CommandTimeouts，消费端零动作）**）；新任务：`thread/start`；
- 容量调度用 host 内建：idle retire（缺省 15min，`set_idle_retire_ms` 可调）自动
  park 回收 worker、rss retire 强收编、maxThreads 32 上限（超发 `thread_limit`）——
  稳态 = 每用户一根轻 host + 仅活跃 session 挂 worker。**host 进程无自退路径**
  （idle retire 只收 worker）：千用户 ≈ 千根常驻 host 进程（每根几十 MB RSS 量级
  + 3 管道句柄 + 1 死线 interval）——web 形态必须开 pool idleTtlMs 并权衡 #TTL
  切 turn 代价（§1），或接受常驻成本显式落档；这是部署预算决策不是 SDK 行为，
  README 给算术不难给出建议缺省。

**并发纪律**：一个 thread 同时只有一个 turn（在飞时 `prompt` 会被 `streaming_window`
拒，worker-commands.ts:215）；服务端按 `userId:threadId` 串行化队列，跨 thread 完全
并行（pending 按 id 对账，天然并发安全）。

## 3. 事件路由（服务端组装面）

- `route(userId, e.threadId)` **两段键拼接才完整**——threadId 只在单 host 内唯一；
- 共享 host 模型下漏按 userId 过滤 = 跨租户泄漏；池形态（每用户一根）结构上免疫；
- 审批 `ui_request`：requestId 是 thread 内一次性令牌（300s 超时按 deny 结算，
  dialogs.ts），回传 `call("ui_response", { requestId, verdict: "allow" | "deny", ... })`；
  消费端应同时监听 settled/超时兜底（host 不保证 ui_request 送达后 thread 还活着）。

**settled 生命周期 = 连接生命周期（消费端必读）**：sendId 配对表只在单连接内
有效——host 崩溃/TTL 回收/evict 后池重建新连接，id 序列从 c1 重新开始，旧
sendId 的 settled **永不到达**且新 sendId 与旧撞名。消费端必须在 exit/onExit
时清 sendId 配对表（未完成 turn 按「传输失败」处理），不得跨连接配对——**SDK 侧
机械辅助**：exit 事件携带当轮在飞 sendId 清单（从 pending 表派生，消费端可直接
对表清理而非自记账）；「must 清单」全部进 README 复杂度对照表的必读栏。
**超时与 settled 的矛盾裁决**：call 超时结算后 settled 照常到达（消费端须容忍
「已判超时的 sendId 后来收到 settled ok:true」——超时只意味着「不再等」，
不意味着「host 没做」；重试前先 abort 旧 turn 是消费端纪律，README 披露）。
**abort 语义（按代码事实）**：abort 即答；被 abort 的 turn 以 settled **{ok:true}**
收尾——settleAfter 只对 turn/end reason.kind 为 error/blocked 置 ok:false
（worker-commands.ts:156-165），aborted/max-tokens 落 ok:true 且 reason 被抹——
**settled.ok 无法区分「正常完成/被中止/max-tokens 截断」**，消费端状态机不得
依赖 ok:false 判定中止（需自持 abort 意图标记；turn/end reason 细粒度判别是
host-hub 专项挂账——08 §4 R8）。abort 后仍需等 settled 确认收敛。
**sendId 空串的内部 settled**：resume 扫尾等「非本呼叫 turn 收尾」信号——
消费端不应整段丢弃而应作「线程有活动但无法归因」的弱信号处理（UI 盲区披露）。

## 4. 重启恢复（懒恢复）

服务端重启后用户回来才 `list_saved + resume`，不启动时全量拉起。多节点横向扩
（sessionsRoot 上共享存储的 realpath/fsync 语义）是部署层专项，SDK 不解决不假装
解决（[01 §4](01-context.md) 非目标表）。

## 5. 越权矩阵与安全边界（安全回归项，测试口径见 07 §5）

### 5.1 前提条件（结构性断言的地基——不是立方断言）

前四行「结构性免疫」**依赖两个前提，均归服务端**：

- **P1 agentDir 互斥**：agentDirOf(key) 必须返回非空且互斥的目录；返回空/
  undefined 时 connectHub 缺省落 `~/.x-harness/hub`——多用户共享同一 agentDir
  各起一根 host，隔离即告失效（B 的 sessionPath 可被 thread/register 拉进 A 的
  账本）；**key 消毒**：key 直接拼路径时含 `../`/分隔符即路径穿越——工厂必须
  消毒（如仅允许 [A-Za-z0-9_-]，或用不可逆 hash 做目录名）；
- **P2 OS 层隔离**：所有 host/worker 同服务 uid 运行——进程隔离 ≠ 凭据隔离；
  同 uid 下 worker 可读任意 agentDir 的 credentials.json（0600 只挡其他 uid）。
  **跨租户部署必须叠 OS 级隔离**（每 uid / 容器 / sandbox），或收敛为「同租户
  单信任域」形态。SDK 在进程层做到它声称的一切；OS 层是部署责任，README
  置顶强制披露（「BYO key 可行」仅在同信任域内成立）。

### 5.2 矩阵（threadId/requestId 维度）

| 攻击向量 | 断言 |
|---|---|
| 用户 A 的 hub 句柄上 call thread/list | 只见 A 的 agentDir 线程（前提 P1 成立时结构性保证） |
| A 的事件回调收到 B 的 threadId 事件 | 不可能（A 的 host 只有 A 的线程）——同上 |
| A 用 B 的 threadId call get_state | unknown_thread（B 的线程不在 A 的 host 账本）——进程账本层成立；fence 的 symlink/TOCTOU 洞见 5.4 |
| A 用 B 的 requestId 回 ui_response | host 空 ack 无副作用（dialogs.ts broker 落空）——但 ack 恒 success:true 是 noop 谎报：消费端不得把 ack 当「审批已送达」 |
| 共享 host 模式（同租户）跨用户事件 | 服务端 route 过滤层职责——SDK 文档披露 + 不提供假保证 |

结构性免疫（5.2 前四行，前提 P1/P2 成立时）进 SDK 契约测试。

### 5.3 管理面命令越权（共享 host 形态的整块风险，跨租户禁用的又一文际理由）

共享 host（同租户）下，管理面命令的作用域是**整根 host**而非单 session：
auth/set_api_key 覆写全 host 凭据；permission/set_mode 五命令改**所有** live
线程权限态（HOST_RELAYED 广播）；thread/delete 删盘；skills/plugins 安装 =
向 worker 注入代码。服务端把命令面透传给终端用户前必须按命令白名单收窄——
SDK 不做命令级授权（薄而不蠢），README 披露「共享形态下管理面 = 租户管理员
面，不是用户面」。

### 5.4 host 侧已知缺口挂账（不属本方案改动面，测试口径钉现状）

fenceSessionPath（read-history.ts:18-34）的两个洞：(a) realpath 失败（文件不
存在）时 symlink 逃逸检查整段跳过；(b) stat 与 worker open 之间 TOCTOU。此外
fence 不要求 sessionPath 规范形（嵌套目录可注册）。这些是 host-hub 安全专项
（跨 app 改动），本方案仅：契约测试钉「现状行为如实」+ 挂账登记（08 §4）。

服务端过滤层与命令白名单是消费端职责，SDK README 披露边界。
