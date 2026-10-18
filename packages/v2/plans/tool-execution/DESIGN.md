# 工具执行链路设计

状态：已核销。工作流：feature-dev-v2，大级新能力，借用存量审计纪律。

## 1. 用户裁决与边界

用户裁决：权限业务由用户插件实现，本轮不实现审批管理、界面、LLM 判权或预设业务策略。提供可异步检查、可撤销许可和准确执行计划的扩展点。真实执行后端交付 macOS Seatbelt 沙箱及显式本地执行，隔离失败不得回退。

core 只增加通用的调用发起者元数据，不增加工具、锁、权限、进程或 AI 概念。内存协调只覆盖同一 tools 实例；外部进程、跨机器锁和数据库事务由对应系统负责。JavaScript 插件作者属于可信计算基；声明效果不是对任意宿主 JavaScript 的安全隔离。

## 2. 执行顺序

输入快照与预算 → 发现安装实例 → 原有 toolAccess → 参数 schema → 工具 prepare 声明效果 → 执行提供者规范化目标 → 冻结执行计划 → 异步权限插件 → 排队意图 → 原子检查许可、工具容量、全部资源 → 执行 → 等待实际任务、进程与输出结束 → 释放全部资源。

审批/外部判权发生在执行名额和资源锁之前。取消可以提前返回，实际任务结束前不释放执行名额或资源。一个许可对应一个服务器生成的计划 ID，不能用调用者 callId 充当授权 ID。参数、安装实例、资源或环境变化必须生成新计划、重新检查权限。

## 3. tools 外部契约

保留 list/get/execute；新增 prepare、checkPrepared、executePrepared、discard、watch。prepare 返回不可伪造且单次使用的 PreparedTool（含只读 plan、同步 status(): Result<ready|waiting>）。终态返回具体错误，不能混入 waiting。它只保存数据与撤销检查，不持有连接、进程、资源锁或调用上下文。discard 幂等。

execute 走同一准备与执行路径，繁忙仍返回 busy。executePrepared 资源争用返回 resource-busy、附加容量争用返回 admission-busy，保留计划与原 intent 次序；普通 busy 不自动重试，其他终态关闭计划。计划绑定 core originId（不可复用的调用者安装 ID）与工具安装实例；停止、卸载或消费后状态终结。tools 的 toolAvailability 事件驱动调度器重新选取，不用轮询等待资源。

工具全局和每安装容量、全部资源、附加 ToolCapacity 在同一段无 await 的提交中检查并占用。ToolCapacity 是框架创建的有界容量对象，用户回调不能伪造；调度器传入全局/批次容量。在这一步之前的 scheduler guard、toolAccess 和新权限检查均不计 running。onStart 只报告已经提交的状态，不参与授权。所有用户 isValid 回调完成后重新检查取消、安装、计划状态，再进行无用户回调的原子提交。

ToolPluginOptions.prepare 可声明 actions（任意命名空间的 JSON 能力）、resources、execution（命令与宿主配置的 profile）。缺省为空效果。prepare 回调与 execute 共享静态声明的依赖，但准备阶段不获得执行命令的能力。

ToolExecutionPlan 包含独立 id、callId、tool、installation、input、origin、originId、initiator、actions、resources、execution。origin 是实际委托者，originId 是 core owner 安装身份，initiator 是 core 记录的整条调用链发起者快照（含不可复用 ID），均不等价于登录用户。宿主自行建立用户身份映射，策略可同时限制发起者和可信委托者。

createToolPolicyPlugin 注册 deny-wins 的工具执行 guard。authorize(plan, call) 可 await 任意宿主审批/LLM/外部策略，返回 allow 或 deny。允许可带同步 isValid、撤销 signal；插件卸载也撤销。执行提交前同步复查所有许可，异常按拒绝。没有配置权限时，原有默认 required 的 toolAccess 拒绝；access:allow 是宿主显式授权。工具权限插件不能推翻其他 guard 的拒绝。

## 4. 资源协调

ResourceClaim = domain + path 分段 + scope(exact/subtree) + mode(read/write)。分段前缀计算重叠，不能以字符串 startsWith 判断。全部声明规范化、去重并采用强模式，原子获取，禁止逐锁等待和持锁升级。同一资源读读并行，重叠写互斥。

准备完成且依赖就绪才加入等待意图。较早的冲突写意图阻止后来的读者插队；互不重叠资源继续执行。取消/丢弃/完成清除意图并通知。单次资源最多 128 个、每路径最多 64 段，每段 1024 字节；actions、准备结果受 64 KiB JSON 预算。maxPreparedPlans 默认 256、硬 1024。每计划一个 tools 插件拥有的独立 core lease task，消费/discard 正常 resolve，取消/超时也合作 resolve，默认最长 60 秒、硬 30 分钟，busy 不续期。它不是 prepare 的子任务。所有终态清除意图、predicate、listener、目标与元数据，保存的关闭 facade 不保留 runtime。准备中的请求另受 maxActiveRequests 和 core task 预算限制，失败完整回滚。

工具安装状态、活动数和资源表由 tools 单一协调，多个 scheduler 共享，直接调用也必须检查。调度器只选择 ready 的节点，不为等待审批或资源的节点占 running；成功父节点实际结束后才准备后继，避免未就绪写者阻塞前驱。

## 5. 执行环境插件

execution 定义平台无关 prepare/run 服务和不可伪造目标。execution-local 与 sandbox 是独立提供者，宿主选择其中一个。用户裁决：sandbox 使用 @anthropic-ai/sandbox-runtime 为底座。profile 在宿主安装时定义，模型不能通过请求切换 backend。命令 argv/cwd/env 在 prepare 冻结；可执行文件必须绝对路径并记录真实目标，cwd 为真实路径，env 为显式完整快照，不能在 run 时重新读取宿主 PATH/env/cwd；符号链接或文件身份变化失败关闭。调用中的 execution.run() 只能运行这个命令，不能更换参数。

文件根使用真实路径与分段边界规范化；同一宿主路径始终使用同一 filesystem domain。命令按全部可读根申请 subtree/read，全部可写根申请 subtree/write。不同 profile 的共享写目录仍冲突。显式本地执行不接受 allowedDomains 配置，以免把未执行的策略表现为生效。沙箱允许读取符号链接自身用于路径解析，链接最终指向的文件仍受真实目录约束。沙箱策略每次生成，禁止合并并发调用的权限。只读由 OS 策略限制写入，网络默认拒绝。运行前通过 opendir 分批读取目录、有界扫描全部用户可读根（写根已包含在内），拒绝多硬链接普通文件，避免路径别名访问根外数据；超出 maxScanEntries（默认 10000、硬 100000）失败关闭。宿主文件系统与同 UID 的外部写入者属于可信计算基，不能在准备/检查和执行之间恶意改动目录。

执行预算：命令 argv 总量 64 KiB、环境 16 KiB，输出 stdout+stderr 默认 1 MiB、硬上限 16 MiB，运行默认 60 秒、硬上限 30 分钟；并发由 tools 与提供者双层限制。新进程组监督，取消/超时终止，等待进程与输出排空才结束。显式说明 Seatbelt 不是虚拟机，不能承诺 CPU/内存/多租户隔离；不支持的需求失败关闭或由用户接入更强后端。

每次执行由独立 SRT worker 初始化单一 profile，禁止并发调用合并全局配置。沙箱的系统运行时读取权限以 SRT 底座为准，用户数据读取通过根拒绝与明确允许限制，不启用 weaker 隔离或 Apple Events。后端不可用返回 backend-unavailable。默认增加单进程约束（拒绝 fork），防止主动 setsid/double-fork 后代脱离监督；明确本地执行仅用于可信程序。需要恶意代码多进程隔离的消费方通过执行提供者接入容器或虚拟机，不以进程组冒充完整后代控制。

## 6. 生命周期与失败

所有新增业务错误为判别联合，中性错误码，不回显参数和秘密。无业务异常逃逸。保存的执行 facade 在调用结束后返回 closed。许可检查和回调抛异常拒绝。准备结果恶意 getter/proxy、超量 JSON、伪造目标、跨调用者计划和重复消费均拒绝。准备被取消后不得注册迟到意图；未合作的准备回调仍占请求预算直到实际完成。

计划安装固定；排队期间替换工具后旧计划返回 stale-plan。scheduler 在有执行机会时重新准备当前名称并重新检查完整权限，不沿用旧许可或资源；直接持有旧计划的调用者收到 stale-plan。这样保留 scheduler 名称晚绑定行为，但每次实际执行都有对应安装的独立授权。

## 7. 切片审查后收敛

最终异步 toolAccess 检查由 checkPrepared 返回不可伪造、单次 ToolCommit；executePrepared 可使用该提交凭证，或自行完成该检查。调度器将 prepare/check/commit 分阶段，前两阶段单独受最多 32 个检查任务约束，不占执行容量；最后一阶段不再等待异步业务权限。只在实际提交时推进优先级与 lane 公平计数。同步许可 isValid 在真实提交前复查；需要立即撤销的业务用 signal，不能把外部可变布尔值的异步 guard 当成可撤销许可。

tools.watch({onChange}) 是全实例有界（最多 128）、绑定调用者 originSignal 的可靠协调通知。它直接触发选择，不依赖可溢出的观察事件队列；toolAvailability(null) 仅用于外部观测。取消订阅和调用者卸载都解除回调，保存的关闭 disposer 不保留运行态。调度器用 revision 判断阻塞回执是否已有新变化，admission-busy 不得无等待重试形成微任务忙循环。core remainingMs 提供同一注入时钟的剩余预算，lease 使用该值，分阶段不刷新截止时间。originSignal 绑定实际调用者安装生命周期，卸载清除遗留意图，终态保留首次 cancelled 原因。批次拥有独立 AbortController，包括结果预算超限在内的停止均关闭全部遗留计划。

代码层并发状态：pending → checking（prepare/check）→ pending → committing（仅内部提交）→ running → done；资源或附加容量争用退回 pending，保留计划 intent 顺序。终态状态必须使当前节点失败并传播到后继，不得永久 waiting。

## 8. 执行后端验证后的收敛

execution-process 只承载进程型提供者共用的配置、规范目标、输出、临时目录和实际结束监督；backend 明确声明 isolation 与 systemReadRoots，不以命名猜测隔离能力。execution-local 配置网络限制时拒绝安装，其任意命令保守申请整个 filesystem/subtree/write。sandbox 的系统运行时读取与公开证书路径同时出现在 restrictions 与资源声明中。

SRT 生成的 profile 通过有界字面量解析附加限制，固定依赖格式变化时失败关闭；不执行解析出来的命令。完整环境先清空再按冻结快照构造，只在受限进程内继承 SRT 注入的代理变量；NO_PROXY 清空，私网地址也必须走同一允许规则，私有 TMPDIR 在运行时注入。worker 控制进程不使用目标环境，stdin 控制帧独立限 256 KiB；目标与 profile 分别受 64 KiB JSON 校验，避免重复传输字段被错误截断。profile 静态环境与最终合并环境均检查 16 KiB。

终止监督等待整个同组进程实际消失和输出排空；stdin 写入与 stdout/stderr 排空并行，避免双向大数据死锁。输出同时检查原始字节及解码后 UTF8 字节。命令和插件拥有的临时目录在实际结束后删除；清理失败如实返回错误，不静默吞掉。已结束的 prepared.status 在独立工厂作用域创建，execution facade 通过可清空 cell 解绑调用，保存关闭句柄、commit、watch disposer 和 facade 不保留请求回调。

真实 macOS 旅程覆盖：可读/只读/可写、symlink 最终目标、read-only 硬链接别名、单进程限制（含解释器 spawn）、参数字面量、并发 profile 的网络允许与默认拒绝。source/dist 混用贯通 policy → scheduler → tools → sandbox，并保留 token 与目标共享身份。进程回收记录有短暂可见窗口，验证实际行为停止后再等待 PID 最终消失，不能用 kill(pid,0) 的瞬时结果推断任务仍运行。

系统读取根只包含 /usr/bin、/usr/sbin、/usr/lib、/usr/share、/bin、/sbin、/System/Library 及明确的公开证书/网络配置文件；不以整个 /System 或 /usr 作为默认读取根，避免把 Data 卷和第三方配置目录包含在运行时权限中。
