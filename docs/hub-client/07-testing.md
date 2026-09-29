# 07 · 测试口径（先于实现定稿）

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；装置事实：[01 §2.10](01-context.md)

分层：单元（假传输/假时钟）→ 契约（真 host 进程）→ 封闭性（hub-protocol）。
测试文件住各包 `src/__test__/`（工程惯例：vitest include `packages/*/src/**/__test__`）；
假时钟 = **注入 now + 注入 timer 工厂（timeout/interval 分物种，Handle 含 unref）**
——两缝均经 testing 子出口（createTestHub/createTestPool 内部构造面，04 §2/06 §1
已撤公共参数；TimerHandle {clear,unref} 定义住 testing 子出口）；仓库惯例是注入
now 非 vi.useFakeTimers（全仓零先例），仅注入 now 推不动真实 setTimeout。

## 1. 命名与组织

- 单元：一源文件一测试文件对置（core/events/stats/ids/pool/process/
  resolve-host/heartbeat-supervisor/connect 各自对置；connect 的 ready 判定/
  reject 面单测注入假 transport，真进程向量归契约层）；
- 契约：`contract-*.test.ts` **按域拆分**（contract-lifecycle / contract-commands /
  contract-jsonl / contract-close-kill / contract-observability / contract-authz——
  oxlint max-lines 500 对测试文件同样生效，单文件必超）；拆分不设合并豁免；
- 回归用例带症状命名（`test("症状：...", ...)`），修复即留档。

## 2. 单元层（假传输 FakeTransport / 假时钟 makeClock + timer 注入）

- **ids**：唯一、单调、连接内永不复用、永不 `@hub-internal:`/`@pending-` 前缀
  （守卫测试：铸造器灌内部状态也不产出；id 仅 SDK 铸造——无自定义 id 向量，04 §2 已删）；
- **core 对账**：按 id 恰结算一次；晚到丢弃+lateResponsesTotal；重复 id 帧丢弃；
  垃圾 error 形状（success:false + error 非 HubErrorShape）按协议失败结算+
  malformedFailures；无 id parse failure 帧不结算任何 pending + protocolFailures；
  进程退出全部 pending 合成 failure（exit 三步次序断言：结算→事件→exited）；
- **core 超时三层优先级**（opts.timeoutMs > CommandTimeouts[command] >
  callTimeoutMs 缺省——三层各自生效 + 逐层遮蔽断言）；
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
  不崩）；心跳死线（假时钟推进 + 卡死假体）；**死线误杀防护**（04 §4-5：主定义含分发窗口时钟冻结（按开始时刻计），
  防护双层 = 非阻塞读排空（缓冲积压不收割）+ 连续两轮确认（单轮静默不收割）；假传输分别预置「缓冲积压」与「回调阻塞恢复
  后首拍」两形态）；stderr 转发；kill 宽限链
  （SIGTERM→killTimeoutMs→SIGKILL，假时钟）；**宽限定时器退出即清**（进程 1s 退，
  5s/45s 定时器不残留）；close 宽限升级（假时钟推过 closeTimeoutMs → kill 路径，
  reason 仍 closed）；**exit 触发锚 stdout 'close'**（进程 'exit' 与残留帧交错：
  预置 exit-先于-排空序列，断言 pending 吃到真实响应而非合成 failure）；
- **pool**：并发 hub(key) 去重（同 key 并发 → 单 connectHub——假工厂计数）；
  acquire 失败不缓存（重试重新调工厂）；exited 清槽 + onExit；**命中槽刷新活跃
  时间 + call 结算刷新活跃时间**（机制已定：pool bindHub 包装层计活——06 §1；无 onSettled 缝）；idleTtl 回扫（假时钟推进 tick）+
  **有 pending 不回收**；**回扫与新 acquire 竞态**（evicting 标记窗口：acquire
  不命中回收中槽——两相位交错用例）；evict 幂等/强制；closeAll（快照/停扫/清场可复用）；dispose（后续 hub 报错误结果）；stats 聚合；
- **resolve-host**：解析序五分支（显式/源入口/dist/装置相对路径/拒启），注入 existsSync。
- **缺省派生断言**：kill/close 宽限缺省字面 === HOST_SHUTDOWN_BUDGET_CEILING + 5_000
  （代码用常量计算而非硬写 45_000——改 CEILING 时 SDK 缺省自动跟随，C8 闭环）；
- **stats 新字段落字**：unknownFramesTotal/parseErrorsTotal/oversizeDroppedTotal/
  framesByKind 四字段在收帧路径的计数向量（unknown 行/坏 JSON/收侧超限/各帧种类
  各自递增断言）；
- **log 词表封闭**：词表全集断言（发非词表 message 的 log 调用 → 类型/测试双拦）；
- **exit inflightSendIds**：exit 三步断言含该字段（结算前快照语义——先结算后发
  事件的次序下清单非空）；
- **connect 装配面**：危险键拦截（消费端 env 带 HUB_WORKER_PROVIDER 等五键 →
  拒启，错误形态断言）；env 合并序（SDK 注入键最后落，消费端同键被拒/被覆盖
  断言）；`opts.signal` 取消（abort 即结算合成 failure "aborted"、晚到响应丢弃+
  计数）；危险键拒启归 connectHub reject 面第四向量；

## 3. 契约层（真 host 进程 + script 假 worker）

装置复用 host-hub kit 现形状（`HUB_WORKER_PROVIDER=script` + `HUB_WORKER_SCRIPT`
env 注入，kit 迁移见 §6）：

- **ready**：首帧心跳 resolve；spawn 失败（hostBin 指向不存在文件）reject；死线内无
  心跳（script 注入延迟首帧）reject；**ready 前进程退出立即 reject**（不等死线）；
- **表驱动命令抽样**：host 本地（thread/list、get_host_info、get_models、settings/get、
  plugins/list、auth/list、unknown → unknown_command 透传——类型层经 testing 子出口的宽入口构造（公共面词表锁不变，测试缝通路落档））+ 线程域全链
  （thread/start → prompt → settled 事件 sendId 配对 → get_state → thread/stop）+
  CommandResponses 第一批**形状对拍**（断言字段存在与类型，不逐值——值由 host 测试
  负责）；
- **二段性**：prompt 受理 response 与 settled 事件分别断言；worker 死亡合成 settled
  （script 剧本中途退出）；sendId 空串的内部 settled 按弱信号处理（不丢弃、可观测——口径 06 §3）；
- **ui_request 往返**：script 剧本触发 confirm 弹窗 → on("ui_request") 回调 →
  ui_response 应答 → 剧本续行；confirmTimeout 超时 deny 路径**不在 SDK 契约层**（broker 在 worker 进程内跨进程注入不可达、真等 300s 违反套件时长纪律）——归属 host-hub 侧 dialogs 既有测试；SDK 层只断「ui_request 到达→ui_response 应答→剧本续行」往返本身；陌生 requestId 的 ui_response 无副作用；
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
- **凭据打码**：auth/set_api_key 的 out 行 onRawLine 回调收到的 key 值已掩码
  （id/形态保留；本地拒行前缀嗅探路径同测——05 §4 脱敏口径）；
- **观测**：stats 计数与真实往返一致（callsTotal/sentBytes/recvBytes/eventsTotal
  与装置侧对账）；
- **log 事件对账**：call_completed（成功侧）/ call_failed（业务失败 + 传输失败侧，
  id/command/reason 单据）在真实往返中断言（05 §3 词表）；
- **abort settled 现状钉**：abort 在飞 turn → settled {ok:true}（代码现状，
  worker-commands.ts settleAfter 路径——R8 挂账的行为基线，改语义时此向量同步改）；
- **fence 现状钉**（R8 可测向量）：symlink 逃逸跳检形态/非规范形注册形态/
  stat-TOCTOU（注入假 stat 替身）——断言现状行为如实（修复后向量随语义更新）；
- **jsonl 边界（真管道）**：跨 chunk 多字节切分、\r 容忍、**超限行（17MiB 单行）
  的 host 侧行为**（丢弃 + 无 id parse failure 帧 + SDK protocolFailures 计数）
  ——触发路径：SDK 本地拒 16MiB+ 不写管道，须用 spawn 测试缝包真 spawn 拿住
  child 引用**直写子进程 stdin**（测试装置能力，不经 call）；字符串分段拼接构造
  控制内存；**分裂超限 + 后随好行**（实测：discarding 只丢超限行自身残余段、
  好行正常产出——3000 次随机切块 fuzz 零丢失；断言该实测行为如实钉住，含
  oversize 计数）；**分帧器分块不变性**（B7 链式重写后单源单实现——对拍对象改为
  自身分块不变性：同一语料按整帧单 chunk / 逐字节 / 随机切块三态**直喂分帧器
  纯函数**（chunk 边界不可经真管道控制），断言产出完全相同的行序列与 oversize
  计数；重写后分帧器住 hub-protocol，本向量住 hub-protocol __test__（C5 扩容））。
- **时序常量注入纪律**：契约层全部时序向量（死线/宽限/孤儿核验）注入
  **缩短值**（heartbeatDeadlineMs 200ms 级 / killTimeoutMs 500ms 级 / close 超时
  同族）——禁止用缺省值跑时序断言（缺省 45s×多向量 = 套件爆炸）；只有「优雅
  close 全链 30s+」这类 host 真节奏向量用真值且单例存在；
- **flake 预案**：契约层真子进程向量偶发红 → 先重跑一次定位（环境性 vs 确定性）；
  孤儿核验用轮询窗口（500ms×10）代替单点断言；连续 flake 的向量降级判据 =
  「真向量在主力 CI 连续 3 次非代码性红 → 转注入链替身并登记」（不是静默 skip）；
- **契约层超时纪律**：真 host 优雅停机单用例墙钟 30s+——逐用例显式
  `test(..., 60_000)`（仓库先例 smoke.test.ts:82）；套件总时长预算 ≤ 5min
  （慢用例并行/精简剧本）；假钟向量（close 宽限升级）用注入 timer 推进而非真
  等待，真/假钟混用按用例隔离（假钟用例不碰真子进程停机节奏）。

## 4. 封闭性（hub-protocol `__test__`，03 §5 全量）

C1-C8（词表/数字锚/错误码/key 序对拍含全字面量锚/jsonl 边界九用例/预算钉子/词表类型封闭+键⊆词表/收编预算钉子）——从 host-hub contracts
迁移并扩容；**host-hub 侧对应断言删除**（同一事实一处断言，03 §5-C2；含
smoke.test.ts:85 与 contracts-frames.test.ts:41 两处数字断言）；gateway
units.test.ts 的 classifyHostLine 用例迁入 hub-protocol——**逐用例迁移对照清单**
（截断前缀向量、无 id parse 形态等构建器对拍天然表达不了的向量显式列出，
防止「镜像删了向量也悄悄少了」）；阶段一验收附**用例数核销**（迁入数 = 删除数）。

环境裁剪纪律（07 §7 同源）：探测机制 = 运行时能力探测（POSIX 信号可用性 +
pgrep 存在性），**macOS/Linux 开发机与常规 CI 必走真向量**（SIGSTOP/SIGKILL 跨
POSIX 可用），仅无信号能力的环境降级替身；探测逻辑与降级路径是装置代码（进
版本控制、可审查），不是隐式 env 开关。

## 5. 回归与安全

- 开发中发现的每个 bug 带症状命名回归用例（CLAUDE.md 铁律）；
- 越权矩阵（06 §5 前四行结构性断言）进契约层；
- e2e **不加新旅程**：契约测试即真子进程全链（仓库既有惯例，先例 smoke-dist
  双形态）；`bun run e2e` 不动；阶段三装置迁移后**全量 host-hub 测试绿**
  = 迁移正确性背书（装置迁移时点已前移阶段三，08 §1）。

## 6. 装置迁移与覆盖率

- kit/host-client.ts 整体迁 hub-client `src/testing/`（经 `@x-harness/hub-client/testing`
  子出口导出；host-hub 旧件删除，测试改 import SDK——dogfood 单轨）；
  workerPids/aliveOf/drivePrompt/contentText 随迁；
  worker-harness/pool-fixture 留 host-hub（它们测的是 host 内部件，不是客户端）；
- kit 装置经 `@x-harness/hub-client/testing` 子出口对 host-hub 导出（08 §2 的
  铁律解法——装置文件住 `src/testing/` 非 `__test__/`；**计入覆盖率分母**
  （命中 include 通配、不命中 exclude——实测口径见 08 §2 装置分母条））；
- 覆盖率：新包自动计入 packages/* 分母（vitest coverage.include 通配），阈值
  90/85 不动；core/events/stats/ids/pool 假传输全单测 → 高覆盖可期；process 契约
  层覆盖；**index.ts 排除**（工程惯例既有 exclude）；command-types.ts 含运行时值映射
  （CommandTimeouts 查表）——计入分母按运行时件标准；
- 汇报口径：用例数 + 行/语句/函数/分支四数字如实报告（不报「门禁全绿」了事）。

## 7. 四门与提交纪律

每阶段独立提交、四门全绿（`bun run lint` / `typecheck` / `build` / `test`）；
lint 门 0 error 0 warning；提交信息引用分册节号。契约测试跑真子进程——CI 环境需
允许本地 spawn（仓库现有 host-hub 测试同款前提，无新增环境要求）。环境裁剪纪律：
探测 = 运行时能力探测（POSIX 信号 + pgrep 存在性，装置代码内实现、可审查）；
macOS/Linux 开发机与常规 CI **必走真向量**；仅无信号能力环境降级为语义等价替身
断言（注入 spawn 链/假体）——断言永在，载体按环境换形，不用 skip。
