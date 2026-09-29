# 07 · 测试口径（先于实现定稿）

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；装置事实：[01 §2.10](01-context.md)

分层：单元（假传输/假时钟）→ 契约（真 host 进程）→ 封闭性（hub-protocol）。
测试文件住各包 `src/__test__/`（工程惯例：vitest include `packages/*/src/**/__test__`）；
假时钟 = **注入 now + 注入 timer 工厂**（04 §2 测试缝；仓库惯例是注入 now 非
vi.useFakeTimers——全仓零先例；仅注入 now 推不动真实 setTimeout，timer 缝补齐
「假时钟推进序」用例的可执行性）。

## 1. 命名与组织

- 单元：一源文件一测试文件对置（core.test.ts/events.test.ts/stats.test.ts/ids.test.ts/
  pool.test.ts/process.test.ts/resolve-host.test.ts）；
- 契约：contract.test.ts（真 host，装置从 src/testing/ 引入）；
- 回归用例带症状命名（`test("症状：...", ...)`），修复即留档。

## 2. 单元层（假传输 FakeTransport / 假时钟 makeClock + timer 注入）

- **ids**：唯一、单调、永不 `@hub-internal:`/`@pending-` 前缀（守卫测试：铸造器灌
  内部状态也不产出）；自定义 id 撞在飞 → 本地 failure 不写管道；**结算后复用被拒**
  （已用集合，04 §3）；
- **core 对账**：按 id 恰结算一次；晚到丢弃+lateResponsesTotal；重复 id 帧丢弃；
  垃圾 error 形状（success:false + error 非 HubErrorShape）按协议失败结算+
  malformedFailures；无 id parse failure 帧不结算任何 pending + protocolFailures；
  进程退出全部 pending 合成 failure（exit 三步次序断言：结算→事件→exited）；
- **core 超时矩阵**（假时钟 + timer 注入推进）：缺省 60s / per-call 覆盖 / 0 关闭 /
  Infinity 关闭 / 超时与正常结算竞态（先响应后超时触发窗 / 先超时后响应）；超时
  结算后晚到响应不复活 promise；**超时从进入 call 起算**（含背压排队：预置
  FakeTransport 挂起 send，验证排队期间计时照走）；
- **core 行超限**：16MiB+1 本地拒（合成 failure + oversizeRejectedTotal）、不写管道
  （FakeTransport.send 断言零调用）；**发送队列上界**（02 B3'）：预置排队字节超限 →
  新 call 本地拒 "send queue full"；
- **events**：帧序保序同步回调、回调抛错隔离（后续帧照发、handlerErrorsTotal）、
  off 解绑、事件名过滤重载、晚订阅不重放（B4 零缓存断言）；**off/on-during-
  dispatch**（快照迭代语义：回调内解绑对后续帧生效，本次已快照不受影响）；
- **stats**：计数器单调、快照只读（外部改不动内部）、守恒断言
  （callsTotal = business + transport + ok）、reset 语义（**pending>0 时 reset 拒绝**）；
- **process**（FakeChildProcess 或注入 spawn）：背压 drain（write false → drain 后续
  写）；**drain 与退出竞争**（进程死于 drain 等待中 → 呼叫被结算非悬挂，drain
  waiter 不残留）；**stdin error 事件**（EPIPE 异步到达 → 传输失败结算、消费进程
  不崩）；心跳死线（假时钟推进 + 卡死假体）；**死线误杀防护**（预置未读积压
  readableLength>0 → 不收割，04 §4-5）；stderr 转发；kill 宽限链
  （SIGTERM→killTimeoutMs→SIGKILL，假时钟）；**宽限定时器退出即清**（进程 1s 退，
  5s/45s 定时器不残留）；close 宽限升级（假时钟推过 closeTimeoutMs → kill 路径，
  reason 仍 closed）；**exit 触发锚 stdout 'close'**（进程 'exit' 与残留帧交错：
  预置 exit-先于-排空序列，断言 pending 吃到真实响应而非合成 failure）；
- **pool**：并发 hub(key) 去重（同 key 并发 → 单 connectHub——假工厂计数）；
  acquire 失败不缓存（重试重新调工厂）；exited 清槽 + onExit；**命中槽刷新活跃
  时间 + call 结算刷新活跃时间**（06 §1）；idleTtl 回扫（假时钟推进 tick）+
  **有 pending 不回收**；**回扫与新 acquire 竞态**（evicting 标记窗口：acquire
  不命中回收中槽——两相位交错用例）；evict 幂等/强制；closeAll（快照/停扫/终态后
  可再建）；dispose（后续 hub 报错误结果）；stats 聚合；
- **resolve-host**：解析序四分支（显式/源入口/dist/拒启），注入 existsSync。

## 3. 契约层（真 host 进程 + script 假 worker）

装置复用 host-hub kit 现形状（`HUB_WORKER_PROVIDER=script` + `HUB_WORKER_SCRIPT`
env 注入，kit 迁移见 §6）：

- **ready**：首帧心跳 resolve；spawn 失败（hostBin 指向不存在文件）reject；死线内无
  心跳（script 注入延迟首帧）reject；**ready 前进程退出立即 reject**（不等死线）；
- **表驱动命令抽样**：host 本地（thread/list、get_host_info、get_models、settings/get、
  plugins/list、auth/list、unknown → unknown_command 透传）+ 线程域全链
  （thread/start → prompt → settled 事件 sendId 配对 → get_state → thread/stop）+
  CommandResponses 第一批**形状对拍**（断言字段存在与类型，不逐值——值由 host 测试
  负责）；
- **二段性**：prompt 受理 response 与 settled 事件分别断言；worker 死亡合成 settled
  （script 剧本中途退出）；sendId 空串的内部 settled 过滤（消费端按 sendId 非空）；
- **ui_request 往返**：script 剧本触发 confirm 弹窗 → on("ui_request") 回调 →
  ui_response 应答 → 剧本续行；confirmTimeout 超时 deny 向量（缩短 confirmTimeoutMs
  env）；陌生 requestId 的 ui_response 无副作用；
- **心跳死线**：卡死真 host（STOP 信号或 script 假体停发心跳）→
  exit(reason=heartbeat-deadline) + pending 合成 failure + stats.deadlinesTotal +
  宽限后 SIGKILL 收割（进程表核验无残留）；
- **优雅 close 全链**：close → host 静默收编窗口（死线已悬挂不误杀）→ exit(0)
  （断言 exit code 而非只 resolve）；close 后 call 合成 failure；**close 宽限升级**
  （script 注入慢停机，假钟推过 closeTimeoutMs → kill 路径，reason 仍 closed）；
- **kill**：SIGTERM 收编（无孤儿 worker——workerPids pgrep -P 核验；非 POSIX CI
  降级为注入 spawn 链断言，断言语义不变）；**末帧不丢**（close 前发呼叫，host
  停机冲刷的末批 response 在 exit 结算前到达——exit 锚 stdout 'close' 的端到端
  验证）；
- **观测**：stats 计数与真实往返一致（callsTotal/sentBytes/recvBytes/eventsTotal
  与装置侧对账）；
- **jsonl 边界（真管道）**：跨 chunk 多字节切分、\r 容忍、超限行（17MiB 单行——
  CI 内存成本可控：字符串拼接分段构造，不用完整 JSON.stringify 大对象）host 侧
  丢弃 + 无 id parse failure 帧 + SDK protocolFailures 计数；**分裂超限 + 后随
  好行**（无界行跨 chunk 到达 → discarding 吞掉下一完整好行——R1 真实触发形态，
  断言现行为如实钉住）；**分帧器对拍**（SDK 链式缓冲泵 vs createJsonlSplitter
  逐字节等价——B7 重写的等价门）。

## 4. 封闭性（hub-protocol `__test__`，03 §5 全量）

C1-C6（词表/数字锚/错误码/key 序对拍/jsonl 边界/预算钉子）——从 host-hub contracts
迁移并扩容；**host-hub 侧对应断言删除**（同一事实一处断言，03 §5-C2；含
smoke.test.ts:85 与 contracts-frames.test.ts:41 两处数字断言）；gateway
units.test.ts 的 classifyHostLine 用例随镜像删除迁入 hub-protocol 对拍组（C4）。

## 5. 回归与安全

- 开发中发现的每个 bug 带症状命名回归用例（CLAUDE.md 铁律）；
- 越权矩阵（06 §5 前四行结构性断言）进契约层；
- e2e **不加新旅程**：契约测试即真子进程全链（仓库既有惯例，先例 smoke-dist
  双形态）；`bun run e2e` 不动；阶段五 host-hub 装置迁移后**全量 host-hub 测试绿**
  = 迁移正确性背书。

## 6. 装置迁移与覆盖率

- kit/host-client.ts 整体迁 hub-client `src/testing/`（经 `@x-harness/hub-client/testing`
  子出口导出；host-hub 旧件删除，测试改 import SDK——dogfood 单轨）；
  workerPids/aliveOf/drivePrompt/contentText 随迁；
  worker-harness/pool-fixture 留 host-hub（它们测的是 host 内部件，不是客户端）；
- kit 装置经 `@x-harness/hub-client/testing` 子出口对 host-hub 导出（08 §2 的
  铁律解法——装置文件住 `src/testing/` 非 `__test__/`，不进覆盖率分母、不属
  __test__ 私有件）；
- 覆盖率：新包自动计入 packages/* 分母（vitest coverage.include 通配），阈值
  90/85 不动；core/events/stats/ids/pool 假传输全单测 → 高覆盖可期；process 契约
  层覆盖；**index.ts 排除**（工程惯例既有 exclude）；command-types.ts 纯类型 +
  窄化辅助函数（有运行时部分才计入）；
- 汇报口径：用例数 + 行/语句/函数/分支四数字如实报告（不报「门禁全绿」了事）。

## 7. 四门与提交纪律

每阶段独立提交、四门全绿（`bun run lint` / `typecheck` / `build` / `test`）；
lint 门 0 error 0 warning；提交信息引用分册节号。契约测试跑真子进程——CI 环境需
允许本地 spawn（仓库现有 host-hub 测试同款前提，无新增环境要求）。环境裁剪纪律：
平台专属向量（STOP 信号/pgrep）在不可用环境降级为**语义等价的替身断言**（注入
链/假体），不用 skip——断言永在，载体按环境换形。
