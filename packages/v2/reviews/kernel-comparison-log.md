# 插件机制持续改进记录

日期：2026-10-16。目标保持进行中：插件机制正确性、性能、上层插件编写便利性、代码架构与设计。当前没有“全面优于Cordis”的证据；不以功能数量衡量目标。

## 依赖门面迭代

独立只读探索定位声明适配的四层认知与分配成本。比较InvocationAccess、ManagedCapabilities和复用现有cell的惰性布局三个方案后选择第三个。Owner及固定绑定以弱键缓存纯字符串布局；只有首次读取deps才生成依赖上下文、服务cell和撤销回调。过期首次读取有完整的方法形状，不能用空对象导致TypeError。正常和清理依赖使用各自快照，已获取服务仍返回service-unavailable，未获取返回cancelled。没有绕过Work、期限、取消、实际结算、等待图或资源保护的模式。

编写公平基准时复现动态Record服务表被类型误拒绝。额外键检查直接采用PluginImplementations的键集合，消除类型层两套事实；方法签名、固定声明额外键负例及运行时完整性仍严格检查。新增动态编译正例、错误方法负例和公开运行回归。

独立实现审查无确认阻塞；建议的Owner间optional、cleanup服务首次延迟读取及超时精确错误码均已永久化。精确GC夹具保持公开句柄存活，退休token可回收；10000轮精确引用检查创建并释放10000资源，动态token保留0，关闭账本归零。

## 可复现测量

命令：`bun scripts/benchmark-kernel.ts /absolute/path/to/cordis > comparison.json`。Bun1.4.3、macOS arm64。两个独立组，每组每场景每实现7个子进程；每个进程预热2000次、测量10000次，批次100。A组先测改前再测改后，B组顺序相反；组内两实现交替。安装与关闭不计入调用时间，计时包含相同结果断言和checksum；每次输出验证并核对总和。

两方plain拓扑为1插件1服务；unused为1插件提供16服务、另1消费者服务；nested为4插件4层调用。缓存服务入口后循环调用。Cordis对象服务没有本系统自动建立的每调用Work、期限、取消、真实actual、工作预算与撤销，因此两方绝对耗时不能被归因为等价DI效率。固定预热没有证明JIT/GC稳态；没有吞吐饱和、真实业务I/O或单请求尾延迟结论。

| 场景 | 改前A组中位µs/调用 | 改后A组 | 改前B组 | 改后B组 | 合并14轮改前→改后 |
| --- | --- | --- | --- | --- | --- |
| 无依赖空业务 | 2.996 | 2.552 | 2.711 | 2.347 | 2.811→2.452，下降12.77% |
| 16个未使用依赖 | 4.901 | 2.659 | 4.447 | 2.364 | 4.525→2.439，下降46.09% |
| 四层依赖调用 | 14.226 | 13.691 | 13.270 | 13.467 | 13.715→13.487，变化1.66%，不认定收益 |

Cordis两组中位数：plain约0.094—0.097µs，unused约0.089—0.093µs，nested约1.998—2.163µs。当前受管调用成本仍明显更高。A组改后unused有一次11.048µs/调用的慢进程样本，未剔除；该组范围2.387—11.048，B组2.334—2.491。本记录只确认未读deps成本的重复中位数下降，不声称尾延迟改善。

原始数据：[改前A](benchmarks/invocation-before-a.json)、[改后A](benchmarks/invocation-after-a.json)、[改前B](benchmarks/invocation-before-b.json)、[改后B](benchmarks/invocation-after-b.json)。四份记录测量器指纹一致，包含实际worker参数、core源、已解析外部依赖文件/包清单、锁文件及git状态，结束再次核对未变化。外层不支持的VM参数直接拒绝，worker清除额外JSC/NODE_OPTIONS/BUN_OPTIONS并启用JIT，不能静默当作传递成功。

[生产源码差异](benchmarks/invocation-source.patch)只作实验记录，不是兼容实现。在隔离副本反向应用可重建改前源码；已实际重建并核对源指纹为0b27d536013facf7bbe8961d882023935f5a59783a8ae09926afbb286f7a64a9。测量器保留在scripts/benchmark中，复测不依赖临时脚本。

## 验证与审查

四门范围为packages/v2：lint零错误零警告，102个内核源码及44个外围源码边界通过；strict和66个类型负例、28个文档示例通过；全部包构建通过；49文件458/458测试通过。覆盖率语句92.47%（3242/3506）、分支89.98%（2120/2356）、函数97.03%（622/641）、行97.83%（2309/2360）。阈值语句90/分支88/函数95/行96未调整，未删除原断言或增加skip/only。

两个隔离源码突变分别恢复逐调用提前构造deps、将过期首次读取改为空对象，均被行为断言拒绝，模块解析或编译失败不算检出。未修改正常交付源码。测量器独立审查发现插件拓扑不等、运行选项遗漏、来源指纹不足，均修正后重新测量；草测结果不用于最终收益数据。文档关于稳态的措辞也已修正。

## 当前差距与下一轮

性能方面，普通派发与受管执行的固定成本仍大，需要继续对取消信号订阅、默认选项读取、结果归一化和等待图分配做剖析。每个优化都需保留既有保证并经多轮测量，不能把语义削弱包装为性能进步。

作者便利性只修复了已复现的动态服务表问题；尚未对全部典型插件旅程完成可量化对照。架构方面已减少未使用能力的提前物化，尚未证明整体阅读和变更成本领先。插件拓扑重装、并发在途调用、失效能力与清理失败的双方同条件机制矩阵仍需完成；目前不核销总目标。

## 取消观察与默认选项迭代

Bun原生CPU采样定位逐工作add/removeEventListener热点。比较直接订阅、AbortSignal.any和私有源观察器后，采用Execution私有弱键观察器。owner/scope/executor每个长期源一个原生once监听器，实际工作结束移除回调；父工作、外部CallOptions及cleanup继续直接订阅。完整sources按身份去重，off幂等且绑定原集合，重入删除、回调抛错和synthetic abort后的新代登记均有回归。null/undefined选项共享冻结无原型空对象，其余输入继续完整校验。公共API不变，没有绕过受管执行的快速路径。

调用保留独立own.signal及中性AbortError。未选择native any，因为它会传播任意source.reason，且带业务abort监听器的dependent存在保活规则；内部桥接还会改变源监听与结果时序。[DOM规范](https://dom.spec.whatwg.org/#abortsignal-garbage-collection)描述dependent保活条件，[signal abort算法](https://dom.spec.whatwg.org/#abortsignal-signal-abort)说明原生传播过程。已接受的私有观察器边界是：自有源上业务自行登记的listener和受管工作间不保证逐工作插入顺序。空闲观察器先于后登记的业务listener处理cancelled，即使后者推进时钟，也不会改写首次结果；外部调用源的前后顺序仍由直接订阅保持。竞态永久化，actual、预算与定时器均待真实工作结束后释放。

同一测量器、Bun1.4.3、固定预热2000/测量10000、每场景每实现7进程；A组先改前后改后，B组反向。保留所有样本，无删慢样本。这里统计进程平均调用时间的中位数，批次分位数仍不能作为单请求尾延迟。

| 场景 | 改前A µs | 改后A µs | 改前B µs | 改后B µs | 合并14轮改前→改后 |
| --- | --- | --- | --- | --- | --- |
| 无依赖空业务 | 2.351 | 1.976 | 2.353 | 2.023 | 2.352→1.994，下降15.24% |
| 16个未使用依赖 | 2.365 | 1.981 | 2.382 | 2.058 | 2.366→2.009，下降15.08% |
| 四层依赖调用 | 12.859 | 11.373 | 13.408 | 11.529 | 13.005→11.395，下降12.38% |

两组均下降，但普通派发和受管执行仍非等价语义；Cordis的绝对成本仍显著低于本系统，不认定性能领先或长期高可用达标。改后范围：plain 1.881—2.311、unused 1.930—2.208、nested 11.226—11.914µs；不得只选中位数掩盖波动。

原始数据：[改前A](benchmarks/cancellation-before-a.json)、[改后A](benchmarks/cancellation-after-a.json)、[改前B](benchmarks/cancellation-before-b.json)、[改后B](benchmarks/cancellation-after-b.json)。四份meterHash相同、各阶段sourceHash相同；[生产差异](benchmarks/cancellation-source.patch)已在隔离副本反向应用，精确重建改前源指纹ac0260966690608d3534cedaa83301aaa89aac4289642dbf0493fdcee2af61f0。测量器及其语义/来源限制沿用上节。

回收审查最初发现第一个取消原因被保留，改前实现亦失败。缩减为完全无Kernel/AbortController的[Promise脚本](benchmarks/promise-home-object.ts)：解释器N=10/100的method保留索引[0,9]/[0,99]，arrow为[9]/[99]；方法HomeObject可把被保留函数连回TaskSpec.signal。堆图只显示直接保护根，不能据此精确命名VM内部原因，也不将它冒充已修复的内核泄漏。GC夹具同站点预热、8个正式method样本全量断言、末尾调用后再GC；成功监听闭包、正式原因样本及关闭Kernel回收通过。永久负控制native-any与显式retain-source均失败于预期回收断言，而非导入/编译错误。准确结论是排除已复现的首/最近VM保留后，正式样本未见额外保留，不能推导全部调用零保留。

独立只读审查无确认阻塞。隔离源码删除sources去重、删除完成回调解绑两项突变均被行为断言拒绝。10000轮创建/释放资源10000/10000、动态token保留0、关闭账本为零。四门范围packages/v2：103个内核源码与44个外围源码边界、66类型负例/28文档例、所有目标构建通过；53文件474测试通过。覆盖率语句92.65%（3278/3538）、分支90.21%（2140/2372）、函数97.06%（628/647）、行97.85%（2332/2383），阈值未改。

下一轮优先把服务、资源、任务、事件和重装五条作者旅程整理成真实编译的同题对照，识别重复事实和认知分叉。尚未证明易用性和整体阅读/变更成本领先；总目标仍在进行中。

## 单一作者声明

服务旅程中抽出函数会遇到位置参数差异：Context/Invocation填写requires、provides、optional，而Implementations填写provides、requires、optional。比较保留别名文档、新增FromPlugin助手、统一Manifest三种方案后，选择单Manifest。所有作者类型从同一份声明派生，inline definePlugin写法不变；没有旧签名兼容层或新增运行时操作。抽出三类函数时，原来9个能力表位置参数变为3个typeof manifest引用；这只是源码层可核对的重复减少，不是用户研究或整体易用性评分。

PluginSpec用反向映射捕获声明，通过NoInfer隔离setup推断，并静态拒绝所有联合分支的额外字段。内部构造端只接受同一份声明；PluginContext、PluginInvocation、PluginDependencies、PluginImplementations和PluginSpec使用同一Manifest，resource/task仅在结果值及业务错误后附加Manifest。旧三个位置泛型的调用全部迁移，没有保留另一套事实。

[指南的独立实现示例](../core/README.md#抽出实现函数)真实编译。新增公开类型正例覆盖setup、实现、Invocation、resource/task、必需及可选依赖；运行用例执行独立函数组成的服务、资源、任务、事件，清理一次且关闭账本为零。新增45个负例拒绝未声明依赖、可选依赖未判空、错误实现结果、Manifest额外字段、缺席表、通过完整及Pick接口索取event/chain权限、联合分支混用kind/服务协议与隐藏字段，以及预先声明的资源/任务/实现扩大方法输入。此前66个负例仍全部成立，动态Record、同协议联合名称、多key回调与结果推导、正确反向赋值均保留。

独立审查发现可选整表过度授权、完整/Pick helper结构越权、联合分支协议任选、联合隐藏额外字段及同源泛型包装短路，均永久化后根治。最终直接使用每协议键组的非泛型调用签名交集，不保留可被Pick擦除的身份见证；同协议名称支持联合变量，不同协议先收窄。服务协议先展开Token与协议两层联合并重建严格函数属性，防止方法双变掩盖窄/宽输入协议差异。Context/Invocation/Task以交叉对象别名展开，资源与实现使用非分发条件结构；完整类型链与变量传递都受约束。

十个隔离类型突变分别恢复这些漏洞及optional/额外键缺陷。每次先确认目标负例在正常源码产生API使用诊断，再确认突变使相同非法用法编译成功，从而被预期拒绝断言检出；不是导入或编译器故障。[故障注入结果](benchmarks/authoring-type-mutations.json)及[脚本](benchmarks/authoring-type-mutations.py)随记录保存，可在packages/v2运行 `python3 reviews/benchmarks/authoring-type-mutations.py /absolute/path/to/workspace`。独立只读收口复核重跑10个负向文件，37个非法位置全部被拒绝；两个正例文件以strict及noUncheckedIndexedAccess编译通过，无已确认阻塞，复核没有代替全量四门。

核心browser bundle用同一Bun1.4.3、仅压缩语法/空白并保留标识符构建，改前与改后109665字节逐字节相同，SHA256为61dc9ee8689dfe156e548ce5b03b09c5ea46b9c3c51ad594cf351ad97d8e9dc6；[脚本](benchmarks/authoring-runtime-equivalence.ts)、[结果](benchmarks/authoring-runtime-equivalence.json)及[源码差异](benchmarks/authoring-source.patch)随记录保存。类型重组不计作运行时性能提升。

四门范围packages/v2：103个内核和44个外围源码检查通过，111个类型负例/29个文档示例，全部构建目标通过；54文件475测试通过。覆盖率语句92.65%（3278/3538）、分支90.21%（2140/2372）、函数97.06%（628/647）、行97.85%（2332/2383），阈值未改。

Cordis的Context扩充及普通方法仍能以更少运行时步骤提供简单服务；本系统的Result、显式声明、setup/request/cleanup边界仍有必要成本。本轮只根治重复类型事实，没有实测证明作者总体编写时间更短。五旅程的双方编译运行对照、重装并发矩阵与结构阅读成本仍待完成，总目标保持进行中。

## 原生作者旅程与替换语义

六组真实作者代码完成服务、异步资源、生命周期任务、事件、提供者替换，以及在途调用的资源排空。脚本为 `bun scripts/compare-journeys.ts /absolute/path/to/cordis`；[原始结果](benchmarks/author-journeys.json)、[各自原生实现](../scripts/comparison/README.md)可复测。没有给core增加API或修改生产运行时代码，也没有把业务差异藏进统一适配层。

两方作者代码统一使用TypeScript7.0.2的strict、noUncheckedIndexedAccess、verbatimModuleSyntax、isolatedModules及相同模块解析参数。Cordis先以自身TypeScript5.9.3和真实项目配置向临时目录生成9个声明文件，作者检查消费这些声明，执行仍导入其源码。两步编译约束分别记录，没有冒称Cordis自身源码通过相同strict编译参数。双方错误服务输入及事件payload共四个负控制均在修改位置产生预期语义诊断，不接受模块解析失败。源码、编译器及类型包实际文件、配置、依赖、工具和生成声明指纹均在结束时复核。

| 行为 | 本系统 | Cordis示例 |
| --- | --- | --- |
| 服务结果、异步资源各开关一次、事件到达 | 通过 | 通过 |
| 取消任务并等待真实函数结束 | startTask自动关联 | disposer显式abort并等待Promise，同样通过 |
| 提供者替换后消费者重启及清理次序 | 重启2次；consumer先于旧provider清理 | 相同业务结果和次序 |
| 保存旧consumer服务入口后调用 | 拒绝，入口已撤销 | 方法重新读取Context依赖，结果为new |
| 函数仍被gate暂停时旧资源是否已关闭 | 否 | 是 |
| gate暂停期间替换是否已完成 | 否 | 是 |
| 原函数继续时是否看到资源已关闭 | 否 | 是 |
| 保存旧provider普通对象再次调用 | 拒绝 | 原方法仍可执行 |

上表的Cordis结果仅针对普通服务Promise未作逐调用登记的写法。保存consumer入口读new来自它的方法再次读取ctx.journeyVersion，不代表Cordis所有旧对象自动重定向；保存provider对象仍是原函数。Cordis可通过公开effect/disposer及作者自己的调用跟踪实现资源保护，不能把默认普通对象行为表述为无法安全替换。我们的setPlugins来自application，Cordis采用dispose/install及Fiber.await，不是相同内核API的步骤数竞赛。共同Result返回是业务协议，本系统要求它，Cordis本可不用。事件也只比较实际到达，本系统发送准入回执与Cordis的parallel结束语义不同。

独立审查在隔离源码中删除closeOwner的actual排空，发现最初停止后立即释放gate的夹具仍然通过，属于验证假绿。修正后gate继续保持，刷新128个微任务，并记录replacementSettledBeforeGate；同一期望在正常副本通过、突变副本失败，突变结果为提前关资源、提前完成替换以及旧函数看到已关闭资源。该故障注入现随每次完整对照执行，正常工作树和Cordis源码未修改。它验证已知故障能被检出，有界微任务窗口不是所有调度交错的形式证明。

独立只读复核连续两次完整运行结果及指纹一致，先前假绿已闭合，无新的确认行为阻塞。复核提出的来源工具漏指纹也已补入。四门范围packages/v2：103内核/44外围源码检查、111类型负例及29文档例、所有构建目标通过；55文件481测试通过。覆盖率语句92.65%（3278/3538）、分支90.21%（2140/2372）、函数97.06%（628/647）、行97.85%（2332/2383），阈值与原有断言不变；新增比较工具不在生产覆盖率统计内。

这一轮得到默认生命周期保证与作者职责的可运行证据，没有证明总体编写耗时、结构阅读成本或性能领先。简单服务仍需面对token、声明及Result的理解成本，Cordis写法更直接。后续优先沿已有CPU证据缩减受管调用固定成本，并用同一组生命周期负控制防止以削弱保证换速度；故障清理与并发替换的完整机制矩阵、长时压力及作者试用仍未完成，总目标不核销。

## 固定Result读取与被撤回的等待图候选

四层调用的CPU采样仍显示等待图遍历开销。先尝试无出边目标跳过可达遍历，自等待仍拒绝，目标有出边仍查全图；没有拆两套图或缓存可达集合。但两组nested中位数分别11.801→11.841、11.955→11.724µs，方向不一致，合并仅下降1.21%。因此生产实现完全撤回，不能把少分配两个容器等同于已证实的调用收益。新增等待图及公开三任务传递环回归继续保留。完整实验：[候选补丁](benchmarks/wait-candidate-source.patch)、[改前A](benchmarks/wait-candidate-before-a.json)、[候选A](benchmarks/wait-candidate-after-a.json)、[候选B](benchmarks/wait-candidate-after-b.json)、[改前B](benchmarks/wait-candidate-before-b.json)。有并发定向测试的初步采样未用作正式数据；这里保存的四组均顺序运行且保留全部慢样本。

转而缩减固定Result结构校验的中间形态。normalizeResult原先调用通用readData，创建无原型字段副本和Result包装，再枚举副本的键；现在直接校验两个自有数据属性，成功值和业务错误不复制，CoreFault仍经过原有完整校验和冻结。没有增加可信标记、跳过校验开关、第二套返回协议或修改任何生命周期路径；生产源码仅这一个函数改变。

描述符按真实ownKeys顺序读取，缓存数据值，不执行getter或Proxy get trap；正反字段序、不可枚举、null原型保持。非普通原型、额外/符号字段、非布尔ok、错误分支、访问器和异常Proxy均拒绝。畸形字段集合现在可能在读取描述符前被拒绝，因此不承诺无效Proxy元操作副作用与次数相同；合法结果的读取顺序及身份规则不变。

独立只读审查运行定向测试，并对1880组输入比较真实改前/后实现，未确认安全或语义回退。[可重跑差分脚本](benchmarks/compare-result-boundary.ts)及[结果](benchmarks/result-boundary-differential.json)亦保留；范围包括字段组合、属性枚举性、原型、业务与CoreFault值，以及描述符变异、删除、访问器、撤销和重入，不是所有Proxy程序的穷举。脚本本身以strict及noUncheckedIndexedAccess编译通过。

性能沿用同一Bun1.4.3、同一测量器和默认JIT，每进程预热2000次、测10000次、批次100。A组先改前后改后，B组相反；各场景每实现每组7个独立进程，组内两实现交替。固定预热不证明稳态，计时包含相同业务断言与checksum，安装和清理不在调用计时内。统计为进程平均调用时间的中位数，不是单请求尾延迟或饱和吞吐。

| 场景 | 改前A µs | 改后A µs | 改前B µs | 改后B µs | 合并14轮改前→改后 |
| --- | --- | --- | --- | --- | --- |
| 普通受管调用 | 2.009 | 1.952 | 2.030 | 1.927 | 2.019→1.932，下降4.34% |
| 16个未使用依赖 | 1.979 | 1.912 | 1.999 | 1.946 | 1.991→1.932，下降2.95% |
| 四层调用 | 11.553 | 11.543 | 11.555 | 11.356 | 11.555→11.424，变化1.13%，不认定收益 |

改后范围plain1.890—2.090、unused1.862—2.003、nested11.237—12.460µs，全部样本保留，不删除慢进程。[改前A](benchmarks/result-before-a.json)、[改后A](benchmarks/result-after-a.json)、[改后B](benchmarks/result-after-b.json)、[改前B](benchmarks/result-before-b.json)的meterHash相同，阶段源码指纹各自相同；[机器摘要](benchmarks/result-comparison-summary.json)保存汇总。[生产补丁](benchmarks/result-source.patch)已在隔离副本反向应用，重建改前core源指纹be3fa8b9dbc75149610c38b885b053e98f3573bb71b7a1982580d6923170b26e，改后为b3a5ec4ec0f5bad1cb60dae9cd5e7b1f4750f559d398bbb22ee1da36abb088ee。两方普通对象派发与受管执行保证不同，Cordis的调用成本仍显著更低，不宣称等价DI效率或全面性能领先。

33个新增Result结构用例、2个服务/任务公开回归、4个等待图用例及1个三任务环回归均通过。40个新增用例在保存的改前实现及交付实现均通过。六项[隔离突变](benchmarks/result-boundary-mutations.json)分别执行访问器、放行额外字段、放行非普通原型、接受truthy ok、绕过CoreFault校验和跳过等待环检查，均失败于预期行为断言；不是模块解析、编译或测试超时。[突变脚本](benchmarks/result-boundary-mutations.py)可运行 `python3 reviews/benchmarks/result-boundary-mutations.py /absolute/path/to/workspace`。完整作者旅程、四个作者类型负控制及实际工作排空突变[复测](benchmarks/result-author-journeys.json)通过。

四门范围packages/v2：103内核与44外围源码边界检查、111类型负例及29文档示例、所有构建目标通过；59文件521测试通过。覆盖率语句92.70%（3293/3552）、分支90.35%（2165/2396）、函数97.06%（628/647）、行97.86%（2342/2393），阈值未改，未删除已有断言或增加skip。只确认两类短调用成本的重复中位数下降，没有内存、尾延迟、整体易用性或长期高可用结论。后续仍需剖析逐调用信号/计时器及依赖门面的固定成本，不能以累计小幅优化核销总目标。

## 按槽位创建依赖门面

Invocation.deps原先整体惰性，但首次读取就创建所有服务门面，并逐槽登记撤销回调。本轮仅修改create-dependencies：多服务表固定可枚举getter，首次读取缓存对应门面，所有槽位共享可撤销source；单服务直接创建唯一门面。getter和方法布局不直接捕获token或Kernel，撤销后source清空。保留普通方法提取、缺席optional、固定提供者、租约失败重试，以及已取得service-unavailable、未取得cancelled的区别；没有添加Proxy、作者开关、额外公共API或改变Work生命周期。多服务属性描述符为只读getter，反射消费者通过属性读取取值，README已明确当前行为。

全getter候选在selective下降16.19%，但nested两组均变慢、合并上升2.21%，因此未交付。单槽没有选择收益，直接创建避免getter后重新测全部四组。其[完整原始记录](benchmarks/slots-getter-candidate.json)和[源码补丁](benchmarks/slots-getter-candidate-source.patch)保留；最终源码首次完整采样[亦保留](benchmarks/slots-initial-batch.json)。测量器条件表达式在lint要求下改为if后，再用最终工具重跑全部四组，没有混用较快候选或删除慢样本。

新增selective场景由一个提供者提供16服务，一个消费者声明全部、仅调用第一个；双方同拓扑、两次业务方法，校验总和一致，并在关闭前核对仅目标方法执行。原三场景的拓扑、调用深度与业务结果保持，工具增加相同分支。所有阶段使用最终相同测量器；Bun1.4.3默认JIT，每进程预热2000次、正式10000次、批次100。A先改前后改后，B顺序相反；每组四场景、每场景两实现各7进程，共224个最终样本。业务断言和checksum在计时内，安装关闭在外。统计为进程平均调用耗时的中位数，固定预热不证明稳态。

| 场景 | 改前A µs | 改后A µs | 改前B µs | 改后B µs | 合并14轮改前→改后 |
| --- | --- | --- | --- | --- | --- |
| 普通受管调用 | 1.900 | 1.907 | 1.902 | 1.908 | 1.901→1.908，变化+0.32% |
| 16个未使用依赖 | 1.898 | 1.920 | 1.925 | 1.892 | 1.913→1.898，变化−0.79% |
| 四层调用 | 11.291 | 10.972 | 11.306 | 11.353 | 11.298→11.209，变化−0.79% |
| 16依赖只调用1个 | 7.660 | 6.537 | 7.795 | 6.576 | 7.698→6.545，下降14.98% |

仅selective认定重复中位数下降；其余变化不足0.8%，不认定收益或回退。改后范围plain1.849—2.210、unused1.866—2.080、nested10.880—11.846、selective6.185—6.977µs。[改前A](benchmarks/slots-before-a.json)、[改后A](benchmarks/slots-after-a.json)、[改后B](benchmarks/slots-after-b.json)、[改前B](benchmarks/slots-before-b.json)与[机器摘要](benchmarks/slots-comparison-summary.json)保存全部数据，工具指纹均为8c8ab6e810b4f1e98f10b91af2e2bb4d4df11b1ee1a97f92eca3e333b4c38a18，Cordis源码指纹相同。[生产补丁](benchmarks/slots-source.patch)反向应用已重建改前core指纹b3a5ec4ec0f5bad1cb60dae9cd5e7b1f4750f559d398bbb22ee1da36abb088ee，最终为0c7c8dec683991514967fb88153aa8d9438fe4a6984f72f4d435a6798577924f；[工具补丁](benchmarks/slots-meter-source.patch)保存新增场景。两方执行保证不同，Cordis普通派发仍明显更便宜；这里不宣称等价DI性能领先、尾延迟、饱和吞吐、内存减少或高可用认证。

三个行为测试覆盖完整冻结形状、缓存、optional与constructor名称、方法提取、失败后容量释放重试和撤销错误码。四个GC测试各检查8个正式样本×17token，总计544token，另检查8个关闭Kernel标记，均可回收；前三类保持宿主活跃。采用与已复现Promise VM现象一致的同站点预热和尾部调用，不把首/末样本算入正式零保留结论。7个新增测试在改前实现和最终实现均通过。[三项突变](benchmarks/dependency-slots-mutations.json)保留source、破坏失败重试、抹去已取得状态，均由AssertionError及预期症状检出；[脚本](benchmarks/dependency-slots-mutations.py)先确认正常用例通过，拒绝导入失败或超时假绿。

独立只读审查发现初始重试夹具把占位服务归于正在执行的宿主拥有者，卸载正确返回plugin-in-use；改为独立插件占位后才能验证释放租约及相同门面重试，未改生产卸载保护。复核完成7个新增测试、额外范围optional与cleanup检查、部分门面及关闭Kernel回收，无确认生产阻塞。[原生作者旅程及实际工作排空负控制](benchmarks/slots-author-journeys.json)复测通过。

四门范围packages/v2：103内核和44外围源码检查、111类型负例、29文档示例及全部构建目标通过；61文件528测试通过。覆盖率语句92.71%（3297/3556）、分支90.34%（2161/2392）、函数97.07%（631/650）、行97.87%（2345/2396），阈值未改，无新增skip或删除有效断言。当前只确认多声明少使用场景的成本下降，长期压力、尾延迟和作者实际使用评价仍需验证，总目标不核销。
