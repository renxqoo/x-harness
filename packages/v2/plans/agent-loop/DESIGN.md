# Agent loop 设计基线

状态：已核销。级别：大；feature-dev-v2，新能力，借用设计/施工/验证三件套，不迁移其他目录的实现。

## 目标与裁决

用户裁决：实现完整 agent-loop；通用内核不服务特定 Agent，扩展通过普通插件公开契约。复用现有模型、调度、权限与沙箱，不复制旧循环实现，不加兼容层。

默认裁决：一次 run 是有界的执行尝试，输入完整且工具结果配对的 LLM 消息，输出完整 transcript 和最后模型响应。options 包含 access（required/allow）与有界 limits。metadata 是可选的只读 JSON 对象，最多64KiB，随 caller/request 传给所有扩展与检查点，不发给模型；它是调用者提供的非可信业务标签，可用于会话选择，必须结合可信 caller 授权。没有永久 Agent 对象、隐式队列或内置收件箱；宿主通过普通上下文插件读取自己的消息队列。会话存储与自动恢复属于独立插件，loop 提供等待确认的检查点，不能拿通知事件代替持久确认。没有自动重试，不自动重放未确认副作用。runId 只标识本次尝试，不承诺跨进程幂等或分布式互斥。

## 公开契约

`agentLoop.run({model,messages,provider?,tools?:string[],runId?,metadata?,onEvent?,signal?,timeoutMs?,...模型生成参数})` 返回 Promise<Result<AgentRun,AgentError>>。未给 tools 时发现当前可见目录，给空数组时不提供工具。不能由调用者伪造工具 schema；每轮从 tools.list 生成，并限制模型实际调用在本轮提供的名称内。每轮重新发现，真正执行仍由 tools 重新授权。模型配置沿用 LlmRequest 类型，providerTools 只由模型协议处理，不能伪装本地工具。

AgentRun 包含 runId、steps、toolCalls、messages、response、stopReason（model/policy/step-limit/tool-limit）及每轮 usage 数组；usage 不伪造缺失计数、不把累计流事件相加。限额前不部分执行整批工具；若下一批超过预算，在调用前结束并返回 stopReason，消息只含已完成的成对 transcript。最后 response 保留请求工具的原始内容供诊断，但未执行的 assistant 不写入可恢复 messages。

`agentRunAccess` 是默认 required 的公开 guard。输入包含 core 捕获的 origin/initiator、runId、step、phase（context/model/tools）和实际 LlmRequest；不得从调用参数自报身份。每轮上下文执行前、扩展输出验证后及工具提交前检查。无策略/拒绝/异常阻止运行；access:allow 是宿主显式信任，不能覆盖其他拒绝。运行中实时撤销由 tools 的完整计划授权/外部 signal 承担，本 guard 只保证各阶段准入重检。所有扩展输入带同一可信 caller（origin/initiator）。

`agentContext` 是公开 chain，输入 {runId,step,caller,metadata?,request}，输出禁止携带 signal 的 AgentModelRequest（其余沿用 LlmRequest）。外部 signal 单独用于整个受管运行，不写入可序列化检查点。普通 middleware 可调整上下文/模型/工具，但输出必须通过 LLM 公开请求验证，并且只能缩减本轮发现的工具名称及保持同名 schema；不能通过上下文扩展注入不可见工具。配置及消息为快照；扩展输出不影响调用前已保存的历史。最终模型请求与返回响应出现在检查点中，用于保存实际可见上下文及 continuation。

`agentCheckpoint` 是公开 chain，输入不可变 {runId,step,caller,metadata?,phase,response,request,messages,results?}，输出 void。默认 terminal 不持久化，普通 middleware 在 next 前/后写自己的存储并必须 await；失败阻止后续动作。检查点与逐项结果使用判别联合：response 禁止 results，tools 必有 results；returned 必有 output，unknown 必有 error。phase=response：模型结束后、工具调用前，含待执行工具意图；phase=tools：本批全部回执到齐并完成成对 transcript 后；无本地工具的完成响应只有 response 检查点。外部存储可用 (runId,step,phase) 幂等键。存储失败不会隐式重新执行模型/工具。

`agentContinue` 是公开 guard，输入最近完成的检查点。默认允许；任何拒绝结束为 policy，不覆盖硬预算、不把拒绝变成错误。仅在一轮工具结果已安全配对后、下一轮模型前检查。没有工具的模型 stop 不因允许而继续。

`agentEvent` 是公开通知事件，onEvent 是等待背压的宿主回调，两者使用同一 AgentEvent 判别联合。事件：start、step-start、model-event（嵌套原 LlmEvent，不冒充已经执行工具）、tool-progress、step-end、finish、error。所有事件包含 runId、递增 sequence，step 事件有 step。finish/error 互斥且最后，仅在调用尚存活、可投递时送达；取消后不保证向已取消的订阅者投递终态。通知沿用 core 的有界队列，不能作持久确认。onEvent 异常/超时/预算失败锁存并立即取消当前模型或工具批次，不启动剩余工具；保存外部副作用风险标记。取消通过本阶段 AbortController 接到实际公开调用 signal，不以末尾错误检查替代取消。保存结束后的回调不保留整个运行。

`streamAgent(service,input)` 提供惰性单消费者异步迭代器及 result。未开始消费不发请求；break/显式 signal 取消；最多一个待消费事件，关闭后清除输入与服务引用。

## 状态机与模型语义

admit → context → model → validate → response checkpoint → [finish | tool batch → tools checkpoint → continuation]。每阶段先检查取消。并发额度从 admit 持有到实际执行子任务结束，取消回执不等于退出。重复在途 runId 返回 busy；退出后不保留去重表。

只有 reason=tool-calls、所有块 complete、每个工具参数完整 JSON 对象且满足本轮目录的 inputSchema、callId 在输入历史与本次 run 全局唯一、名字属于本轮提供目录，才进入调度。模型响应、目录快照 schema 或公开 JSON 硬预算的整批校验失败时，整批零执行。该检查不预留各节点的权限和运行额度；工具替换、撤销、较低的实际工具预算仍可能在其他工具执行后失败，这类结果按 unknown 停止处理。reason=tool-calls 但没有调用属于无效模型输出。length/pause/refusal/content-filter/other/stop 中的工具块均不执行；含未执行调用或 incomplete 块的响应只保留 response，不追加到可恢复 messages。空 assistant 响应映射为一个空 text 块。所有成功返回的 messages 必须可通过公开 LLM 请求校验。模型请求失败或部分流失败返回 model-failed，不从 delta 执行工具。

有序映射 text/refusal/reasoning/provider/tool-call；reasoning/provider 原生 continuation 原样保留 provider/protocol/model，跨模型错误由 LLM 校验。隐藏推理不能变成文本。无法回放的 provider 块拒绝继续工具循环，不能静默丢失后继续。工具回执按原 callId、输入顺序映射 tool 消息；文本/图片原样，structured 以额外 JSON 文本块提供；空输出补空文本，业务失败 isError 保留。任一工具 Result 设施失败都保守标为 outcome=unknown：错误码不证明外部副作用未发生。生成中性 tool 错误消息与带 unknown 标记的结果检查点，然后结束 tool-outcome-unknown，不再问模型，不自动重试；工具自身正常返回 isError 属于已确认回执，可以继续。整批设施失败结束且 toolsMayHaveRun=true，仅有已保存意图，宿主必须对账，不能丢失风险事实。错误仅报告代码不回显异常内容。首次提交工具批次后，整次运行的 toolsMayHaveRun 单调为 true，后续模型/上下文/检查点失败都保留。core 取消/超时回执可能先于实际函数结束且为 CoreFault，不能用其中缺少业务字段推断没有副作用，恢复方仍须检查已保存意图。

## 预算与生命周期

单轮工具调用硬上限复用 tool-scheduler 公开 maximumSchedulerLimits.maxBatchCalls（256），回执与预检使用同一事实。超出整批硬上限时在任何执行之前拒绝，不能执行后才因检查点计数失败。

默认：8 个运行、16 次模型请求、64 次工具调用、128 个工具、512 条 transcript 消息、上下文/完整 transcript 4MiB、单事件 1MiB、累计事件 16MiB/100000 条、运行 180s、消费者 30s。配置受硬上限：64/128/1024/128/4096、16MiB、4MiB、64MiB/1000000、1800s/300s；所有数必须安全正整数。模型与工具现有预算仍独立生效，不放大其上限。期限包含上下文、模型、检查点、工具排队/审批及消费者等待。

检查点序列化上限为 transcript 字节预算的三倍（实际模型请求、完整消息及响应），有限复制不构成无界缓冲；工具执行前预留整批结果消息的数量。工具结果超过 transcript/检查点预算时停止并报告 toolsMayHaveRun，不能静默截断或自动重试。历史/context 的 callId 索引最多 maxMessages+maxToolCalls。JSON 快照使用有界深度/节点读取，不执行 getter/toJSON，使用无原型记录避免属性赋值污染原型。没有后台队列/重试计时器。运行只创建 core 托管任务；消费者超时也在 core 子任务中处理。卸载取消全部运行，实际工作排空后归还额度。关闭 stream 清除捕获引用，GC 专项验证。

## 边界

本包不包含数据库、Session 业务投影、跨节点运行锁、工具 exactly-once、上下文压缩算法、重试路由、审批 UI、沙箱实现。对应普通插件承担；示例和真实 SQLite 旅程验证检查点可持久化、重开读取并由宿主显式续跑。response 意图检查点后崩溃而缺 tools 结果的运行不可盲目重放，应由宿主对账/工具幂等协议解决。扩展插件为受信任 JS，不是安全隔离边界。

宿主 onEvent 抛错会取消整次受管调用，立即返回 core cancelled；消费者超时返回 core timeout。这样即使模型或工具忽略 signal，调用方也能结束等待；实际工作排空前保留运行额度。取消回执不携带 AgentError 的副作用字段，恢复必须查已保存的调用意图。consumer-failed 仍用于流接口消费协议错误与未启动成功的消费者任务，不能据此推断远端执行已结束。

模型或工具在途的事件验证/预算失败同样取消整次调用，返回 core cancelled，防止忽略 signal 的执行拖住失败回执；尚未发起模型的预算失败仍返回 capacity-exceeded。
