# 通用插件平台

本目录包含通用插件内核与独立外围包的实现、架构、公开接口与验收标准。内核实现位于 core/src，公开入口是 core/src/index.ts；各包的单元测试与资源回收检查放在同目录 __test__ 中，组合旅程放在 fixtures 中。

core 是与业务无关的 Context 插件宿主。应用通过插件定义服务、调用链、决策关口和通知事件，再组合成普通服务端、AI 应用或其他应用。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [内核使用指南](core/README.md) | 接入包、快速开始、插件编写、扩展点、资源与在线装配 |
| [架构与边界](ARCHITECTURE.md) | 内核职责、依赖方向、服务作用域、扩展机制与保证边界 |
| [公开接口](API.md) | 类型签名、错误语义、服务调用、事件、调用链和宿主操作 |
| [实现说明](IMPLEMENTATION.md) | 数据结构、算法、生命周期状态机、实现阶段与工程组织 |
| [插件示例](EXAMPLES.md) | 外部应用的服务、材料、重试、权限与组合示例；普通 HTTP/SQLite 应用见 fixtures/server-application |
| [验收规范](VERIFICATION.md) | 契约、故障、类型、资源、性能与外部应用组合测试 |

接口和行为以 API 为准，模块职责以 ARCHITECTURE 为准，交付步骤以 IMPLEMENTATION 为准。示例必须满足接口；实现改变这些规则时，同一变更先更新规范，再更新实现和测试。

## 固定决策

1. 保留 Context 风格的 `definePlugin`、`setup(ctx)`、`service/deps`、`on/dispatch/emit` 和作用域机制。
2. core 不包含 Agent、会话、对话、模型、工具、房间、Bot、skill、压缩、权限规则和沙箱实现。
3. 持久化、业务状态投影、检查点、恢复和可靠消息投递全部是外部插件的职责。
4. core 管理自己的内存注册表、插件实例、调用、任务和资源生命周期，不恢复 JavaScript 执行栈。
5. 服务消费者取得固定实例的受管门面，不取得提供者的原始实现对象。
6. 服务方法统一返回 `Promise<Result>`；它们可以接收进程内对象，不强制 RPC、JSON 或跨进程序列化。
7. 通知事件、处理调用链和决策关口分别定义语义，不共用含义模糊的回调包装器。
8. 插件可以使用调用链短路和顺序重试；core 限制并发、迟到调用、深度、预算和取消。
9. 插件能请求关闭，宿主负责等待关闭；没有等待自身卸载的插件接口。
10. 安装批次先暂存再发布；回滚保证注册与资源管理，不声称撤销任意外部副作用。
11. 数据错误、状态冲突、缺失依赖和资源上限通过判别联合报告，不能抛业务异常。
12. 测试按行为、不变量和故障场景验收。覆盖率作为遗漏诊断，不能作为提高测试数量的替代目标。

## 交付边界

`/Users/wrr/work/x-harness/packages/v2` 是全部实现的统一工作区。内核、领域契约、插件、适配器、测试夹具和配套构建配置都在本目录内组织，独立构建与验证。领域插件和应用夹具位于内核模块之外，仍在本工作区之内。

内核公开产品入口固定为 `@x-harness/core`，源码位于 `core/src`。本目录作为独立工作区组织，不修改其他目录的代码、包入口和构建配置，不建立兼容接口或私有路径别名。

本规范不授权发布、推送或修改外部系统。

## 使用与验证

插件通过 `definePlugin` 与 `setup(ctx)` 声明并登记服务、处理器和资源；宿主通过 `createHost`、`install`、`uninstall` 和 `close` 管理其生命周期。插件拿到固定依赖门面，业务调用通过 `call.deps` 和 `call.dispatch` 自动关联父工作、取消和截止时间。具体写法见插件示例。

在本目录执行：

```sh
bun run typecheck
bun run lint
bun run build
bun run test
```

typecheck 包括公开入口正例、111 个编译负例和文档插件示例；lint 包括类型感知检查、纯内核依赖边界和外围包公开入口边界；test 在 Bun 下运行并生成覆盖率诊断。测试组织及具体异常矩阵见 [测试说明](core/src/__test__/README.md)。

core 是进程内插件宿主。npm 包获取、模块导入、配置审批与执行隔离由外部宿主提供；已导入插件的在线装配和卸载由 core 提供。通知事件使用内存队列，可靠投递与业务持久化由外部插件提供。

## 外围包

| 包 | 职责 | 文档 |
| --- | --- | --- |
| core | 通用插件机制、固定依赖和生命周期 | [内核指南](core/README.md) |
| plugins/session-sqlite / session-postgres | SQLite / PostgreSQL storage providers | [Storage contract](plugins/session/README.md) |
| plugins/session | 持久历史、有效对话、分支恢复与事务提交 | [会话插件](plugins/session/README.md) |
| standard | logger、timer、JSON config | [标准插件](standard/README.md) |
| application | 期望插件集合、待定依赖和自动重新装配 | [应用装配](application/README.md) |
| loader | Bun 构建、稳定共享契约、文件监听和受限 HMR | [模块加载](loader/README.md) |
| create | 本地 SDK 插件工程生成器 | [脚手架](create/README.md) |

core不依赖这些外围包。只需要固定装卸时直接使用createHost；需要依赖出现后自动激活时使用createApplication；需要文件热更时使用createLoader。作者仍只编写definePlugin和setup(ctx)，不需要了解加载器内部。

当前工作区采用公开 TypeScript 源码入口，各包源码与构建产物复用同一core源码身份。构建产物供Bun或TypeScript bundler使用，外围产物通过相对公开入口连接core，避免根工作区其他包名映射影响token身份。脚手架生成工程的构建产物可直接用Bun运行。发布包清单和远端注册表发布不属于本地交付。

SDK内的tsconfig已将示例中的公开包名映射到本目录入口，可在本目录直接运行Bun示例。外部工程建议先用create脚手架生成，它会写入明确的本地SDK入口，确保服务token来自同一份core。

## 插件机制对照测量

在本目录执行 `bun scripts/benchmark-kernel.ts /absolute/path/to/cordis > comparison.json`。测量使用同一Bun、独立子进程、相同插件拓扑和业务结果，两方交替运行7轮，报告全部原始样本、来源指纹和分布。仅支持默认VM选项；worker明确启用JIT并清除额外运行选项。固定预热不代表已证明JIT/GC稳态，批次平均时间的分位数不能解释为单请求尾延迟。

Cordis普通对象服务与受管服务的执行保证不同，报告同时列出语义边界。对照结果和已知差距见[迭代记录](reviews/kernel-comparison-log.md)，不以功能数量、覆盖率或单次最快值判定全面领先。

本地会话追加日志由独立 [JSONL存储插件](plugins/session-jsonl/README.md) 提供，与SQLite/PostgreSQL实现同一存储契约。
