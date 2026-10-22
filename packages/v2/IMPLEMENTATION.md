# 内核实现说明

## 工程边界

实现位于 packages/v2，生产入口为 core/src/index.ts。源码使用 TypeScript strict、function 和 Result。内核不包含平台 I/O、业务类型、兼容入口或代码注释。应用组合位于 fixtures，测试位于所属模块的 __test__。

## 状态工厂

createRegistry、createExecution、createLifetime、createAssembly 保存各自的私有状态，返回冻结端口。createHost 仅组合端口、时钟、诊断和可撤销门面。定义描述由弱引用保存，宿主活跃引用由 Registry 管理。

| 状态 | 建立 | 释放 |
| --- | --- | --- |
| 定义引用 | 安装预留、宿主登记和子范围继承 | reference→definitions 局部反向索引 |
| 依赖绑定 | 规划固定 Provider，预留成功后建立消费者索引 | Owner 关闭时解绑 |
| 服务 lease | 首次成功解析，绑定调用或范围 | 提供者、拥有者、调用或清理控制结束 |
| 实际工作 | 执行前登记并连接父子与等待边 | actual 结束后统一释放计数与引用 |
| Effect | 外部资源分配或登记前建立 | 实际清理成功后移除；失败保留 |
| 通知队列 | 首次使用事件登记时创建 | 撤销清空载荷与容量等待 |
| 实例引用 | 成功安装或 inspect | 弱引用身份表，不伪造跨宿主权限 |

## 作者接口

definePlugin 安全快照声明，只建立定义。requires、optional、provides 都是命名映射。setup 的普通作者门面显式列出能力，scopeState 保持动态 getter，不展开宿主控制接口。

命名入口统一通过 readCapability 检查字符串和自有属性，不对垃圾输入执行字符串转换。服务实现与处理器的输入输出由映射类型推断；宿主和跨范围底层接入使用 Context。

registerServices 只选择 provides 中的服务，先完整快照所有实现与 options；prepareImplementation 拒绝 getter、额外方法和错误形态；prepareProvision 校验可见性、槽位、遮蔽和身份。检查整批 Effect 容量后，在没有外部回调和 await 的同步段登记。单项回执仍走统一撤销屏障。

createDependencies 为服务建立方法门面。成功取得的 lease 可以缓存，临时 resource-limit 失败不缓存。optional 的固定缺席返回 undefined。方法、任务和资源取得收到当前受管调用的依赖视图；初始化依赖只属于 activation。

## 装配和发布

planLoad 验证名称、映射、定义身份和数量，解析本批、局部与祖先 Provider，构建固定关系。orderInstall 用消费者邻接表和按输入位置排序的最小堆完成稳定拓扑排序，复杂度为 O(E + V log V)。循环在任何 setup 执行前拒绝。

reserveInstall 保留定义引用和槽位，之后才把 Owner 与消费者关系加入活跃索引。计划失败不写活跃反向索引。setup 的每次执行均登记 activation。在激活工作中，activateDeclarations 先通过同一 Context.register 为声明的 event/guard 建立暂存登记，再进入作者 setup；不反向导入标准机制模块。

Install.owners 保留插件激活和回滚顺序；participants 包含同事务创建的子范围 Owner。publishInstall 校验所有参与者和各自作用域，再同步发布 Provider 与处理器。未绑定 staging 子范围的执行入口关闭，登记可以暂存。

失败时先停止准入和取消，然后按逆依赖顺序 closeOwner。未实际收敛或子范围清理失败时保留完整关系并标记 degraded。公开失败回执不意味着槽位和资源已经释放。

## 执行状态

startWork 校验准入、父工作 bodyOpen、深度和数量，读取安全调用配置，并合并相关信号与期限。Executor 是实际执行者，resourceOwner 是逻辑消费方；清理视图可以显式指定资源拥有者。

有效执行限制由调用视图作用域、Executor 作用域与父 Work 限制取交集，存于 Work。调用、任务、等待与 next 准入共同读取该快照，依赖上下文切换执行身份不重新放宽限制。

Provider 的撤销信号参与业务执行取消，关联 Work 计入提供者 Owner 的活动集合。卸载先停止能力，再等待实际排空；清理调用保留自己的控制信号。默认调度器按单调截止时间分段安排长计时，取消句柄只撤销当前分段，不遗留后续计时器。

executeWork 在函数体结果确定后关闭 bodyOpen，随后连接并等待已登记孩子。这样收尾微任务不能在最后一次 join 后登记新孩子。actual 完成前仍保持活动记录和容量，settled 只表示真实结束。

outcome 保存第一次结果。超时或取消先结束 outcome 并发出信号；函数迟到成功不能覆盖它。实际结束时撤销 Invocation、依赖 Context、lease、计时器、信号监听与等待边。

等待图同时记录父子连接和显式等待，引用计数支持同一边的多个等待者。等待结束、取消和超时撤销其消费者订阅，不取消目标。容量等待保存可撤销通知，不忙轮询。

## 资源取得

openResource 先建立 Effect 和固定清理依赖，再创建取得 Work。取得工作收到自己的 Invocation，依赖调用归于它；成功值先写入已登记记录再交付。

取消或超时后，没有交付的成功值等 actual 收敛后立即释放。失败没有句柄时清理空登记，不调用外部 close。分配内部部分失败且未交付句柄的补偿由 adapter 负责。

成功交付的资源随归属者关闭。ctx.resource 属于插件，call.resource 属于逻辑消费方；没有从裸 T 自动推断借用关系的承诺。提前关闭通过明确的范围生命周期完成。

## 关闭与清理

stopLifetimes 统一停止 Owner 和 Scope 的准入、撤销入口并传播取消。closeOwner 是插件卸载、作用域关闭和安装回滚共同使用的资源关闭路径。closeScope 和 uninstall 收集对应报告与生命周期集合，不实现第二套资源释放算法。

先等待实际工作，关闭拥有的子范围，在保留依赖实现的条件下释放资源，然后撤销 Provider、处理器、lease 和引用。清理失败不阻止其他独立资源尝试清理；需要失败资源的 Provider 保留。子范围失败必须反馈父 Owner。

releaseEffect 复用一次清理 Promise，使用独立信号、固定截止时间和固定依赖。没有显式 bound 的 cleanup 不回退业务 activation。清理调用携带 Effect.owner，受管嵌套调用继承它；所有清理工作实际结束后才移除记录和 pins。

手动提供者撤销先检查消费者、其他资源 pins 和在途工作；拒绝时不进入永久释放状态。开始后的撤销、卸载、关闭与回滚使用同一释放规则。重复操作不扩大期限，不隐式重试失败清理。

## 标准机制

Service 负责方法适配和校验，Registry 负责身份和撤销，Execution 负责实际调用。Chain 与 Guard 使用 Registry 的 Provider+Scope 处理器索引捕获稳定计划；次序来自有序集合，不维护额外排序计数。

Chain 为每次 next 建立当前处理器的子工作与 Continuation 观察。并发锁等实际结束才释放。Guard 对明确决策顺序聚合，缺失配置失败。

Event 的队列、运行标志、来源序号和待投递数只存于 createEventQueue。单监听者 actual 结束后启动下一条；预算不足等待 Execution 容量通知。退休登记调用内部撤销钩子，移除载荷和容量订阅。

## 验证方式

lint 检查类型感知规则、分层、运行时无环、平台依赖边界、无 class 与代码注释。typecheck 检查 strict 工程、公开类型负例和文档代码。build 按包的平台边界使用浏览器或 Bun 目标打包。test 在 Bun 下运行公共接口、故障、GC 与应用组合，并执行覆盖率阈值。

普通服务端组合使用真实 SQLite 和 HTTP，两轮安装、请求、级联卸载与重装验证资源回零。Agent 组合是另一个外部应用夹具，不向内核添加业务接口。

## 运行定位

inspect 按账本当前状态生成冻结图：插件固定依赖、提供者、实际工作及资源。已取消工作在实际结束前保留；资源在真实清理成功前保留，失败显示 failed。错误摘要最多复制每类 8 项并保留 total/omitted；范围关闭、级联卸载和手动关闭使用相同摘要生成路径。诊断边界使用已有 JSON 限额复制并深冻结，sink 不可写回内部状态。
