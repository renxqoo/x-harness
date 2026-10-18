# Tool scheduler 设计基线

状态：已核销；级别大，新能力，feature-dev-v2。用户裁决：默认只阻止失败节点的后代，其他节点继续。不增加持久队列、跨进程租约、重试、后台提交或模型/会话知识。进程内调度不是跨机高可用承诺。

## 契约

createToolSchedulerPlugin({access?:"required"|"allow",limits?})返回Result<Plugin>，提供toolScheduler与toolScheduleAccess，依赖tools。execute接受ToolRequest加priority?、mode?:"wait"|"immediate"，返回工具结果；batch接受calls:[{name,callId,input,dependsOn?,priority?,timeoutMs?}]、concurrency?、signal?、timeoutMs?、onProgress?。批次progress为{callId,delta}，必须await。batch成功返回{results:[{callId,result}]}，按输入顺序；节点失败保存在result，不抛业务异常。依赖失败含isError:true，后代返回scheduler/dependency-failed，不执行。参数无效、重名callId、悬空依赖、自环/环整批拒绝，零工具副作用。

execute模式默认wait；immediate不能等待正在占用的调度名额，返回scheduler/busy。批次全部原子准入，不部分入队；超过最大请求数/未结算节点数返回queue-full。execute/batch请求期限包括授权、工具说明查询、排队及执行；节点timeoutMs从开始执行计时。取消请求/调用者卸载/调度器卸载移除排队节点并取消运行子工作。不合作实际函数继续占槽，直到TaskHandle.finished。批次普通报告等待已运行子工作实际结束；整体取消/期限能先返回core故障，实际工作继续可见。

SchedulerError词表：invalid-input、queue-full、busy、access-denied、dependency-failed、capacity-exceeded、closed。嵌套节点保留ToolsError和CoreFault，所有公开结果检查形状、输入快照不可变、错误中性不回显秘密。

## 权限、身份与动态变更

toolScheduleAccess检查{operation:"execute"|"batch",origin,calls}，origin取外层core调用；默认required，缺策略拒绝，allow是宿主显式委托，deny优先。排队委托以工具名称表达，工具安装在开始执行时绑定；不承诺排队时绑定某次安装，执行时仍由tools做新鲜授权、schema验证与安装身份封印。卸载原工具不会重试，找不到或冲突保持失败。

scheduler以自己声明的tools依赖调用执行，tools权限看到scheduler插件身份，原始调用者由toolScheduleAccess单独检查，不能伪造/透传origin参数冒充core身份。权限插件需要分别允许原始调用者提交任务，以及scheduler执行委托；README必须完整展示。工具参数不承担用户认证。调度不绕过tools，直接tools调用仍受tools容量保护；直接调用、其他调度器或运行时工具变更导致busy时保留失败，不轮询重试可能有副作用的调用。

## 调度与预算

FIFO调用者lane键由受信任origin(scopeId/pluginName)生成；可运行lane轮流各取一个节点；优先级仅在lane内生效（-10到10，默认0）。每lane连续3次优先级选择后强制取最早可运行节点，避免低优先级饥饿；依赖未满足或工具满额的节点不阻塞其他可运行节点。资源饱和/不合作函数下不承诺墙钟等待上界。全局、每工具及每批次并发同时满足。每工具并发取tools.get声明，创建批次时读取；工具动态变化仍由tools最终限额保护。

默认concurrency=8、maxPendingCalls=256、maxRequests=32、maxBatchCalls=128、maxInputBytes=1MiB、maxResultBytes=4MiB、timeoutMs=60s。硬上限分别128/1024/128/256/4MiB/16MiB/1800s。pending容量包含已准入且尚未实际结束的全部节点，依赖阻塞也计入；结果累计按实际UTF8 JSON字节限额，超过时整批capacity-exceeded并取消其余节点。配置的执行并发应不大于tools实例执行限额，且受core更短期限与资源上限约束。无额外原生timer，每请求一个core控制任务，运行节点各一个core任务。任务/监听/队列闭包在实际结束撤销；inspect只给计数，不输出业务参数或原始异常。

## 结构与验证

contracts、domain读取与DAG检查、queue选择、runtime任务管理、插件工厂分离。一动词一文件，function优先，无代码注释。不改内核调度语义，不复制tools私有验证器。共享公开token支持源码/构建混装。基线874文件指纹保存在/tmp/tool-scheduler-baseline，复用已附着隔离worktree，逐路径集成不覆盖其他在途代码。

先做单任务排队切片并四门/独立审查，再扩DAG、公平性、progress与容量；完整实现审查及假绿负控，相关真实HTTP新进程旅程、类型负例与完整示例、基准与故障突变。全工作区90/88/95/96覆盖率门槛不降低，报告实际用例和四类覆盖率。

## 公共验证复用

工具契约新增tools/validation公共入口，导出readToolJson(raw,limits)、readToolOutput(raw,maxBytes)、readToolError(raw)，内部复用tools唯一既有验证器，不复制实现或新增别名兼容路径。scheduler对公开批次结果的嵌套工具结果也执行同一验证。该入口一并加入公开导出、构建共享模块和平台依赖边界。

inspect({})返回{running,queued,requests}，只含计数。容量参数正式命名maxOutstandingCalls（代替草稿中的maxPendingCalls），统计已准入但尚未真正退出的节点，不把已结束节点继续当作排队；失败依赖节点及取消的未启动节点立即释放。请求准备/授权阶段也预留请求及节点容量，避免无限授权等待占内存。

原始提交者授权在准入时和每个节点取得执行名额后、tools.execute之前重查；使用同一冻结operation/origin/calls，队列等待中的策略撤销生效。重查等待占用running名额并受整体期限，不能制造无限审批并发。授权检查完成后仍存在普通调用的瞬时配置变化窗口，不承诺事务冻结外部认证系统；实际工具始终再经tools授权和身份封印。

图预算覆盖完整规范化calls及依赖元数据；callId最多128字符，每个dependsOn长度不超过calls.length-1且拒绝重复。immediate也进入同一lane公平选择，当前轮次没有取得执行名额就busy并撤销，不允许插队。公共JSON读取器正式名readToolJson，接受maxBytes/maxNodes/maxDepth预算；复用tools唯一实现。

公共报告验证先检查整份JSON的16MiB硬预算，再验证各节点结果，防止自定义服务提供者绕过累计限制；完整calls额外最多20万JSON节点、40层嵌套，工具自身更严格的输入规则仍生效。

构建scheduler时将tools公开index作为共享源码入口外置，避免打包器跨export-star及外部contracts组合生成未定义重导出变量；新进程双向混装旅程直接验证产物可执行。

批次准备时为依赖构造Node引用索引，选择和失败传播不反复按ID线性查找；同批同名工具说明只查询一次，形成该批次准入快照，不做跨请求缓存。执行前原提交者复查和tools最终新鲜授权维持逐节点执行。真实HTTP旅程将child放parent前，直接核验服务端finish(parent)先于start(child)，避免FIFO顺序掩盖依赖失效。

容量循环等待边界：工具执行中若await同一已满调度器的wait请求，整体期限终止该等待并排空，不能假装自动释放父工具名额或超配执行。嵌套调用建议immediate并处理busy，或直接调用已声明工具服务；显式批次关系用dependsOn。调度器不分析任意函数内部的隐式等待图，不承诺递归执行器语义；回归同时覆盖wait有界超时和immediate可恢复busy。
