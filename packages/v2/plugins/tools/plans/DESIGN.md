# Tools 设计基线

状态：已核销，已完成独立方案审查与实现验收。级别：大，新插件子系统。工作流 feature-dev-v2。用户授权实现工具定义、校验、受控执行、动态装卸及策略扩展；不复制已有工具源码。

## 1. 边界与装配

工具插件独立于 llm/session。tools 提供 list({})、get({name})、execute({name,callId,input,signal?,timeoutMs?,onProgress?})，均返回 Promise<Result>。list 返回有序不可变工具声明，get 返回声明或 null；execute 返回文本/图片内容、可选 structured JSON 对象和 isError。业务工具失败可以是成功回执中的 isError:true；设施失败为封闭 ToolsError，core 错误保留。没有自动执行模型调用、自动重试、会话限制、批量调度、权限规则、沙箱或具体文件/命令工具。

createToolsPlugin({access?:"required"|"allow",limits?}) 默认 required：没有有效策略时拒绝。allow 是宿主显式信任所有声明工具，不是安全沙箱。公开 toolAccess guard 支持外部权限/审批插件，拒绝优先。列表/详情同样经过权限检查；execute 权限在最终工具作者入口执行，即使有受信任插件直接调用原始执行扩展，也不能略过该关口。策略不接收可伪造的身份字段；origin 来自 core 调用上下文。调用方 metadata 不充当权限身份。

createToolPlugin({name,description?,inputSchema,outputSchema?,requires?,optional?,concurrency?,limits?,execute}) 返回 Result<Plugin>。inputSchema 根为 object，通过受支持 schema 推断作者参数类型；不要求作者维护另一份类型断言或解析器。execute(input, call) 的 call.deps 只包含该工具声明的依赖，另有 callId、name、progress(delta)。Result 复用 core；工具作者不用捕获初始化 ctx.deps。

## 2. 动态发现与身份

工具通过内核的目录链和执行链登记 middleware，登记自动归工具插件生命周期。tools 不保存任意插件 Context、执行闭包或独立的可变注册表。工具安装/卸载即影响目录；激活失败不发布半份工具。目录声明带每次安装独立 registrationId，execute 先取得一次目录快照，再携带此身份路由；审批期间卸载并重装同名工具不能执行替代实现。

同名工具导致目录 name-conflict，不能按注册顺序挑一个；目录快照含冲突时，该次请求在副作用前失败。已经取得无冲突目录快照的在途请求固定原安装身份，之后新增同名工具不追溯取消或重定向该请求；后续新请求会发现冲突。卸载原安装仍按core取消与排空。这是准入快照语义，不承诺在动态配置变化后重新审批。目录与执行链是受信任作者内部扩展，不是任意用户 HTTP 接口。默认目录32项，硬上限128；链深度仍受core maxCallDepth约束，大工具集需宿主明确提升该限额。目录遍历 O(工具插件数)，不宣传为 O(1) 路由；先保证生命周期与依赖权限正确，不用失效缓存掩盖动态装卸。list/get/execute 在一个 tools 实例的可见范围工作，不把 root 实例宣传为自动发现子租户范围。

工具入口同时执行 schema 和权限校验、每工具并发准入，不能只在可绕过的门面校验。默认每工具 concurrency=1，允许明确提升；不自动判断纯读操作一定安全。tools 实例默认总并发32，队列0，满即busy。每次实际执行归core受管工作，不脱离父调用。取消/超时回执与 actual 结束分开：全局槽须等TaskHandle.finished，每工具槽须等作者实际返回及progress实际结束，才能释放。

## 3. 数据与错误

JSON 只接受普通数据属性，拒绝访问器/符号键/稀疏数组/循环/非有限数字，深度32/节点10000；不可变快照，不冻结用户原对象。输入64KiB、输出1MiB、单进度16KiB、累计进度1MiB/10000条，硬上限分别256KiB/4MiB/64KiB/4MiB/100000。图片内容显式区分绝对HTTP(S) URL和带mediaType的base64，不代拉URL；structured 只接受JSON对象。允许空content但不能整条结果缺少content；图片、structured与content合计计预算。最终输出和每条progress都先校验和快照。未知字段拒绝，不偷偷修补。

schema 使用已安装的 Ajv 8，注册时编译一次。安全子集：type、properties、required、additionalProperties布尔、items、enum/const标量、min/maxLength、min/maxItems、minimum/maximum、description/title；schema16KiB/深度16/节点1024/enum128，无$ref/远端、正则、format、组合与递归。不转换类型、不补默认、不删除字段。input 根object，outputSchema若声明则约束 structured；没有 structured 或不匹配为 invalid-output。schema编译和生成代码预算按每工具256KiB，失败在安装前明确 Result。

封闭领域错误：invalid-input、invalid-schema、unsupported-schema、invalid-output、not-found、name-conflict、access-denied、busy、capacity-exceeded、cancelled、timeout、execution-failed、consumer-failed、closed。错误不回显输入、输出、异常message或秘密，仅稳定中性 message。未知/伪造错误归 invalid-output；core 原始故障不改写。

progress 是 await 的文本增量通知，不是最终输出的自动拼接。作者必须等待；并发或遗留progress导致失败；回调失败先锁存，不能被作者忽略后伪装成功。订阅者慢施加背压。总期限默认60s、硬上限1800s；progress回调默认30s、上限600s，同时受父调用更短期限约束。取消立即传播；不合作的作者/回调继续占槽，不能假报结束。有限timer与监听在实际结束清理，保存已关闭progress函数不能保留call/请求/服务引用。

## 4. 验证和部署

先跑目录→参数校验→文本执行→卸载的最小正式切片，再扩权限、并发、图片/structured、progress与竞态。设计及资源密集实现由独立只读审查者审查。三件套和行为矩阵随实现维护；不得删断言、skip或降低90/88/95/96门槛。

源码/产物共享唯一内部及公开token，Bun完整包部署或应用整体打包，不只复制dist。独立新进程运行构建入口与实际 HTTP 工具，并核对取消时实际连接关闭和进程退出。性能基准记录动态目录规模、路由/验证开销与源码指纹，不声称远端工具性能最优。故障突变验证失效身份、漏校验、丢取消、提前释放容量、忽略progress失败和秘密回显都能检出。

## 5. 实施前细化

目录链采用受限 visit 回调逐项交付声明，结果为void，避免每层中间件重新复制增长中的整份目录。回调在查询结束撤销，并锁存重复/预算/晚调用错误。执行链输入使用内部封印ticket，注册身份、参数和回调不可由中间件替换；叶子再次确认安装身份，并校验参数与权限。内部token和ticket身份表在源码/产物间保持同一模块。

总期限与取消直接复用core call.spawn/call.wait/TaskHandle.finished；进度回调也是有限子任务，使用core消费者期限和signal，不另建一套调度器。回调超时会取消该回调信号；实际未结束仍由core账本保留并阻止释放容量。不承诺在进程内强制终止不合作的回调。所有领域错误的原始core失败保持首次回执，不人为伪造为领域timeout。

依据：[Ajv安全](https://ajv.js.org/security.html)及[选项](https://ajv.js.org/options.html)要求把schema当作受信任程序并控制复杂度。本包只接宿主/工具作者静态schema，仍限制大小、深度、词表与生成代码；不以这些预算宣称任意不可信schema安全。

caller 从外层 tools 服务 call.origin 取得，封印在内部 ticket；作者上下文通过 caller 明确提供它，不把内部链调用的 call.origin 伪称外部身份。

## 6. 实现审查裁决

独立审查指出：additionalProperties必须显式检查布尔，不能将任意子schema交给Ajv；实例预算须经封印ticket传递并与每工具限额逐项取最小；progress回执与实际结束必须分离。

core增加通用call.cancel(reason?:"cancelled"|"timeout")：只取消当前调用并结算其首次CoreFault，实际工作仍由账本排空，不允许任意业务错误绕过结果验证。工具服务将显式请求signal/期限绑定当前服务调用，消费者期限失败也通知该调用；不能等到外层默认超时才响应。方法不包含任何工具或模型知识。LLM显式请求取消也复用这一通用入口；回归覆盖非合作消费者情况下的首次回执。生产core修改与类型/行为测试同变，不保留旁路实现。

取消桥接最终只使用core任务/处理链的首次回执、call.cancel和finished；内核先保存首次取消原因再通知后代，根调用按该原因发布回执。不在工具层建立setTimeout或用performance猜测注入Scheduler的期限，虚拟时钟与真实时钟均保持timeout原因。

取消因果由core工作树保存封闭原因（cancelled/timeout），先记录首次原因再广播原生abort；子工作与等待者继承父工作原因。外部signal.reason不读、不透传，原生DOMException不变，不引入第二套时钟或额外计时器。注入Scheduler与真实时钟使用同一条路径，防止下层派生取消覆盖上层首次超时。
