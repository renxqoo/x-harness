# 内核实现说明

## 1. 实现边界

实现 API 中的一个通用 Context 内核包。核心实现全部使用 function，不使用 class，不写代码注释，不添加兼容接口。错误以 Result 表达。

全部实现与配置仅位于 `/Users/wrr/work/x-harness/packages/v2`。本工作区独立构建和验证，内核公开入口为 `@x-harness/core`，内核源码为 `core/src`。领域契约、插件、适配器和应用夹具分别放在本工作区 contracts、plugins、adapters、fixtures 中。其他目录不属于当前实现范围，不修改其代码、入口和配置。

用户已确认按本规范实现。本任务授权在本工作区实现与验证，不包含推送或发布。

## 2. 内部记录

| 记录 | 必要字段 | 拥有者 |
| --- | --- | --- |
| RootRecord | 限制、调度器、定义索引、诊断、预算、mutation 管理 | 根宿主 |
| ScopeRecord | 父引用、状态、局部绑定、子作用域、close Promise | 创建者 |
| OwnerRecord | 插件实例身份、状态、固定依赖、资源、任务和调用 | 装配作用域 |
| DefinitionRecord | 定义对象、名称、kind、validator、引用计数 | 根宿主 |
| ProviderRecord | token、作用域、实例身份、实现 cell、状态、消费者 | 插件或宿主 |
| RegistrationRecord | token、处理器 cell、拥有者、顺序、状态 | 注册者 |
| CallRecord | id、父 id、双方身份、signal、截止时间、真实 Promise | 调用双方 |
| TaskRecord | id、父调用、拥有者、signal、真实状态、结果 | 创建者 |
| EffectRecord | 资源 id、函数、生命周期拥有者、清理执行者、固定清理依赖、执行 Promise、清理状态 | 唯一拥有者 |
| EventJob | 快照、来源、监听登记、队列位置 | 监听者 |
| InstallTransaction | 私有定义与提供者、激活序、回滚序、取消与发布状态 | 目标作用域 |

没有模块级可变服务表、全局 token 强引用缓存或跨宿主的可变状态。标准定义对象可以作为模块常量；实例状态必须在根宿主或其子记录中。

## 3. 推荐文件组织

```text
core/src/
  contracts/
    define-service.ts
    define-chain.ts
    define-guard.ts
    define-event.ts
    validate-definition.ts
    result.ts
  context/
    create-context.ts
    bind-context.ts
    inspect-context.ts
  services/
    provide-service.ts
    bind-service.ts
    invoke-service.ts
    revoke-provider.ts
  chains/
    provide-chain.ts
    register-chain.ts
    dispatch-chain.ts
    continue-chain.ts
  guards/
    provide-guard.ts
    register-guard.ts
    dispatch-guard.ts
  events/
    provide-event.ts
    register-observer.ts
    snapshot-event.ts
    emit-event.ts
    drain-events.ts
  plugins/
    plan-load.ts
    activate-plugin.ts
    publish-plugins.ts
    rollback-plugins.ts
    unload-plugin.ts
  scopes/
    create-scope.ts
    request-close.ts
    close-scope.ts
  tasks/
    spawn-task.ts
    wait-task.ts
    cancel-task.ts
  effects/
    register-effect.ts
    release-effects.ts
  diagnostics/
    report-diagnostic.ts
    read-diagnostics.ts
  index.ts
```

内部类型根据拥有者就近组织。文件名表示一个动作；不能为了凑文件数量拆出没有边界价值的透传模块。公共入口不导出 Record 或原始 handler。

## 4. 定义与方法绑定

声明阶段检查名称、属性描述、methods 形状和 validator。拒绝访问器和异常原型；读取 Proxy 的描述抛错也转换为 Result。

服务实现按契约的方法名建立 cell。门面方法闭包只保存可撤销 lease，不直接捕获完整实现对象和宿主。撤销后清空可释放的消费者与提供者引用，保留最小错误身份；实际在途调用仍保留必需引用直到结算。

消费者方法签名与实现方法签名通过映射类型关联。实现增加 Invocation，不改变输入和结果类型。消费者提取方法后不依赖 this。

服务实现对象不能包含额外可绕过的方法。注册时不执行 getter，输出不重新拼装业务 Result，以免丢失业务字段。

## 5. 安装算法

1. 入队前校验并预留 mutation 容量，再在根宿主队列串行进入，校验目标作用域；拒绝或完成时释放容量。
2. 校验插件名、manifest、定义身份、重复项和提供者冲突。
3. 从本批次、目标作用域已发布提供者及已发布祖先解析 requires/optional，固定绑定。
4. 建立提供者到消费者的有向图，检测环，按输入顺序稳定拓扑排序。
5. 创建私有 staging 记录；本批次可见，外部不能 use、dispatch 或订阅其登记。
6. 按顺序激活。每次调用先登记 activation，再调用 apply。
7. 校验声明项已提供、返回 Result 合法、资源已登记，且无失控结构化子任务。
8. 全部成功后重新校验祖先状态和依赖代次，一次发布定义、提供者、处理器和依赖边。
9. 任一步失败，先撤销 staging 准入，再取消所有 batch 工作，逆依赖顺序回滚。

staging 插件自身的事件不交付给批次外监听者。通过已发布依赖产生的外部副作用不属于原子发布保证。激活函数应尽量登记能力；无法撤销的外部行为应由插件自己的业务协议处理。

发布使用一次同步的注册表引用切换或等价不可观察的 commit；中间不能 await。异步工作发生在发布之前或之后。

激活超时先返回失败并请求取消，不删除仍运行的 activation 记录。迟到返回不得发布；预登记闭包随后取得的资源和迟到返回的 disposer 均保留拥有关系，进入回滚。关闭后不重新开放普通登记入口。无法收敛的事务标记 degraded，拒绝新装配，不放行假的成功安装。

## 6. 状态机

```text
Scope:
open → closing → closed
                ↘ close-failed

Plugin:
staging → active → stopping → stopped
   ↘ failed           ↘ failed

Task / Call:
pending → running → settled

Install:
planning → staging → publishing → committed
              ↘ rolling-back → rolled-back
                              ↘ unsettled
```

cancelled 和 timeout 是调用对外结果，不能代替 Task/Call 的真实 settled 状态。close-failed 在未决工作随后全部结束、没有清理失败时可以进入 closed；历史失败回执不改写。

## 7. 卸载和关闭算法

卸载根据实例身份而非仅字符串名称操作。普通卸载先检查已绑定消费者；cascade 计算受影响集合，逆拓扑顺序停止。

关闭请求立即设置 admission 为关闭并发出取消，不等待 mutation 队列。实际关闭按以下顺序进行：

1. 阻止新业务登记、调用、任务和子作用域。
2. 撤销入口，取消在途调用、任务及未开始通知。
3. 等待实际工作结算，将预登记闭包取得的迟到资源与迟到返回 disposer 纳入清理。
4. 在保留提供者实现与长期资源的清理模式下，先释放关闭子树内全部 Invocation.effect 消费方资源，再关闭创建者拥有的子作用域。
5. 按消费者先于提供者的顺序清理插件，同一拥有者内逆资源登记顺序清理。
6. 汇总所有清理失败，继续尝试其余资源。
7. 释放注册表、lease、计时器、监听器、等待边和可以释放的引用。
8. 没有实际未决工作和资源失败时设置 closed。

cleanup 使用独立的截止时间 signal 和 CleanupContext 窄接口。清理 lease 按 EffectRecord.executor 固定清理执行者的依赖代次，允许调用 stopping、尚未最终释放的提供者，不复用已中止的业务 signal。清理调用计入提供者 drain，消费者清理实际结束后才能最终释放提供者。清理门面及 cleanup 阶段 bind 均不能恢复业务准入。

截止时间不因迟到工作重新开始。迟到 disposer 收到已中止 signal 仍被尝试；真实释放失败保持 close-failed。先通过 Invocation.effect 登记持有未来句柄的清理闭包，再打开外部资源；登记失败不得分配。实际创建 Promise 结算前不能清理空句柄并丢失随后到达的资源。

重复关闭共用一个操作及 Promise，不重置截止时间。关闭超时返回 close-incomplete 及剩余身份，真实 drain 仍被追踪。外部宿主可以据此终止隔离进程，core 不自行退出进程。

默认不重试失败 disposer，避免重复产生不可逆副作用。需要恢复的业务资源由其插件提供明确操作。

## 8. 调用与取消算法

开始任何服务、chain、guard、observer 或 task 之前检查拥有者和祖先状态、固定绑定以及预算，再先登记 CallRecord。

通过 call.bind(ctx) 显式绑定嵌套调用父身份，合并消费者、提供者、父调用和显式 signal；任一取消中止本次调用。绑定门面只能访问当前执行者获准使用的依赖与作用域。普通 ctx.use 不推断异步父调用，不设置全局当前调用。合并信号监听器归本次调用，实际 finally 解除。cleanup 使用独立清理 lease 的准入路径。

对外截止时间和真实工作完成分开记录。对外可以先返回 timeout，但底层 Promise 始终连接失败观察和最终清理，不产生未处理拒绝。

Invocation.spawn 的子任务归本次调用；父调用结束前连接等待。ctx.spawn 是显式拥有者级后台任务，不随一次方法返回自动结束，但随拥有者关闭。

Invocation.wait、绑定嵌套调用、continuation、父子任务与自动连接等待都登记边并检测环。TaskHandle.id 与任务执行 Invocation.id 使用同一工作身份。等待结束、取消、目标结束、等待超时均释放对应边；自动连接边保留到实际收敛。宿主 wait 不建立来自业务任务的等待边。

调用堆栈、next 次数和资源总量都有预算。超过限制先返回 resource-limit，不先创建资源再补账。

## 9. 调用链算法

按 root 到本作用域收集登记，固定处理器身份、实例和顺序。终结处理器也是受管提供者。

每次中间件进入建立 frame，记录 activeNext、nextCount、closed 和 next 的观察状态。next 开始前校验输入、signal、deadline、代次和预算。

一次 frame 可以顺序多次 next；同时存在 activeNext 时拒绝新的 next。对外 timeout 不能清空 activeNext，只有真实执行结算才能释放。处理中间件返回后 frame.closed 为 true，任何迟到 next 失败。

使用函数创建局部 Continuation thenable，不修改全局 Promise，不通过覆盖原生 Promise.then 推断 await。追踪 then/catch/finally 的派生链；await 或直接返回转交观察责任，派生链被丢弃仍能检出。内部失败观察与插件观察分别记录，业务 Result 失败不等于 Promise 拒绝。返回时未结算 next 触发 unfinished-next；失败未被插件观察触发 unobserved-next。两种情况都取消并追踪已开始的工作。

追踪限于自有 Continuation 链，成功结算的未观察派生链不报错。原生 Promise.resolve 吸收与 await 无法区分，外部容器的丢弃不在检测承诺内。可信插件负责管理自己的未登记 Promise。

短路保持输出校验。调用计划中的登记被撤销时，如果对应处理器尚未进入，失败而不是跳过。当前已经进入的处理器仍归在途账本，按其取消和真实结束处理。

## 10. 通知算法

入队前完成输入校验、JSON 快照和长度/深度/节点预算检查。JSON 快照使用有界遍历和路径上的循环检测，不调用用户的 toJSON，不执行 getter。

确定当前源作用域及祖先可见监听者，原子预留整组投递容量。payload 只创建一份不可变快照，监听者共享只读数据。

每个监听者串行，监听者之间由有界调度器公平运行。撤销监听、关闭拥有者或超时会取消未开始投递并释放容量。

观察者实际未结束时不能启动同一监听者下一次执行；超时暂停该监听者，诊断与其他监听者继续工作。没有事件丢弃后假装成功的可靠性承诺。

## 11. 实现阶段与交付物

| 阶段 | 实现 | 必须通过的验收 |
| --- | --- | --- |
| A | definitions、Result、预算、调度器与诊断 | 非法输入、类型负例、诊断有界与无递归 |
| B | scope、effect、task、signal 与关闭 | 取消竞态、自等待、重复清理、迟到工作、资源回零 |
| C | 服务提供、固定绑定与门面 | 提供者卸载、消费者关闭、提取方法、输入输出类型 |
| D | chain、guard、event | 顺序重试、并发/迟到 next、guard 阻断、慢观察者 |
| E | install、publish、rollback、unload | 原子可见性、依赖绑定、回滚失败、关闭打断激活 |
| F | 公开插件示例、工作区集成与资源验证 | 类型实例化、内核依赖边界、GC 与集成门禁 |

每阶段先写可观察结果测试，再实现对应模块。完成意味着模块测试、类型负例和适用门禁通过，没有把未解决失败隐藏为成功。

内核测试及类型夹具统一放在 core/src/**/__test__/，只通过公开入口验证可观察行为。外部应用及其持久化、进程隔离旅程由领域模块自己的测试负责，业务实现不进入 core 生产代码。不执行 e2e 总入口。

## 12. 独立工作区集成

本工作区配置独立 typecheck、lint、build、test，发现与构建范围必须覆盖本工作区的内核、契约、插件、适配器和夹具。不能仅凭其他目录通过验证宣称本实现已经被构建或测试。

依赖检查增加新的纯内核边界，禁止生产源码导入业务包、node/bun 平台 I/O、未声明外部运行时依赖。类型化 lint 命令必须实际启用对应能力。

覆盖率统计可以保留。不得降低现有门禁、扩大排除项或跳过测试换取成功。新增测试以故障与行为约束为目标，不以覆盖率数字决定是否正确。

本工作区配置独立 manifest、公开 exports、构建脚本和依赖检查。工作区内消费方只使用公开契约，没有 src 私有路径转导出、重复字段或兼容层。当前实现不安排其他目录的代码迁移或删除。

只提交点名且属于本任务的文件。共享产物有他人变更时留待协调。没有 push 或 publish 步骤。

## 13. 源码组织

| 目录 | 当前职责 |
| --- | --- |
| contracts | 声明工厂、不可伪造 token、判别结果、输入读取与校验 |
| context | 宿主及窄门面、Invocation、只读检查 |
| services | 代次解析、固定门面、受管调用和撤销 |
| chains / guards / events | 调用链、决策关口及有界通知 |
| tasks | 真实工作账本、结构化任务、等待图、首次结果与取消 |
| effects / scopes | 资源依赖、清理执行、关闭期限与实际收敛 |
| plugins | 批次规划、串行装配、发布、回滚及级联卸载 |
| runtime / diagnostics | 内部记录、默认预算、身份、准入与有界诊断 |

生产源码没有外部运行时依赖、平台 I/O、类或代码注释。测试使用可推进单调时钟和可控 Promise 构造竞态；GC 用例运行隔离的 Bun 子进程，并保留调用门面、资源 disposer、Invocation 与 TaskHandle，验证宿主对象可以释放。

## 本次完整审查整改约束

所有审查用例和报告纳入当前工作区。实现以同一套资源生命周期为基础：definition 对身份和所有声明引用统一计数，安装先预留再发布，失败先取消整个批次再逆序清理。子作用域只能继承创建者已经获得的固定能力。

执行预算涵盖输入验证和实际执行。后台任务属于插件生命周期，只有 Invocation.spawn 才进入调用的结构化子任务树。等待具有默认预算、固定截止时刻和可撤销订阅；调用和清理上下文在结束后撤销并释放运行时引用。原生取消信号通过安全读取和订阅入口接入。

清理回调返回不代表实际调用已经结束。清理必须等待所创建调用的实际结束，失败保留依赖固定引用；关闭报告以本次操作实际释放资源及整个子树停止插件计数。生命周期底层通过注入能力工厂创建上下文，生产模块依赖不得形成运行时循环。质量验收依据异常、并发、引用释放、状态和权限不变量测试，覆盖率只作为诊断数据。
