# 插件宿主架构边界对抗审查

本报告检查当前公开入口、API、架构文档与真实生产实现；先独立读实现与契约，再阅读已有 `core-adversarial-2026-10-15.md` 区分新发现和复核。生产源码未改。所有命令及新增测试位于独立 worktree `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2`；没有提交、push、发布、修改依赖、读取凭证或运行旧工程。

结论：通用插件宿主的抽象方向可支撑企业 Agent 底座，不需要向 core 增加 Agent、上下文、权限规则或恢复业务类型；当前实现仍不能作为已通过生产验收的底座交付。新增作用域自身能力继承反例和已有定义身份问题违反已承诺的通用机制，企业插件无法通过正常装配消除它们。内部层次也与文档不一致，但本轮未证明导入环本身产生运行故障。

## 1. P2，新发现：插件创建的作用域丢失自身已提供能力

分类：实现违反已公开不变量，不是要求 core 增加业务能力。

位置：

- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/scopes/create-scope.ts:32` 新建拥有者，33–35 行复制插件身份与 requires/optional 绑定，未委派创建者的自身提供能力。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/services/resolve-provider.ts:17` 只检查当前拥有者的 providers，19 行在有 pluginName 时立即返回 undeclared-dependency，根本没有进入祖先查询。
- 契约依据：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/ARCHITECTURE.md:93` 的本地及祖先可见性，101 行的插件可使用自己已提供契约；`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/API.md:462` 的获准子作用域绑定。

公开反例：一个 provides=[token] 的插件先 ctx.provide(token)，ctx.use(token) 成功；随后 ctx.scope() 创建归属自己的子作用域，child.use(token) 返回 undeclared-dependency。没有兄弟插件，没有 shadow，没有可选依赖，没有复制定义，没有传入伪造 Context。

红测：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts:156`。168 行期望取得合法门面，实际返回 `{ ok: false, reason: { source: "core", code: "undeclared-dependency" } }`。

影响：插件通过自己的受管服务组织子实例时，改用独立子作用域后无法继续组合自身服务。若为了绕过缺陷保存父 ctx 的未绑定服务，会改变实际调用来源及资源归属，也失去子调用取消与期限继承；若每个子作用域重新 provide，则改变服务实例语义。这不是可接受的企业组合协议。

修复方向：把“可用能力委派”和“资源拥有者”显式分开。创建插件所属作用域时，对创建者的固定依赖与自身提供能力建立受控的提供者身份引用；能力解析、清理依赖快照与卸载保护共用此关系。不能仅让带插件名称的 child 任意搜索祖先，那会同时开放未声明的其他插件能力。验证应覆盖创建前后提供能力、撤销/重装代次、嵌套子作用域与正常关闭，保持 optional 的固定缺席语义。

## 2. P2，已有 R12 复核：定义身份账本只由提供者驱动

分类：已有发现，当前源码仍存在；本轮不重复计作新缺陷。

位置：

- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/plugins/plan-load.ts:33` 仅遍历 provides 维护名称身份，45 行的预算检查也只计算这些定义。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/plugins/plan-load.ts:47` requires/optional 进入拥有者绑定，但没有进入定义账本。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/services/provide-definition.ts:31` 后续普通 provide 仅依据这个不完整的账本检查名称冲突。
- 契约依据：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/ARCHITECTURE.md:65` 的根宿主定义名称唯一性，以及 `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/API.md:497` 的 maxDefinitions。

两个公开反例分别验证不同不变量：maxDefinitions=1 的宿主成功装配 optional=[tokenA, tokenB] 的插件；已经有 optional 绑定持有 tokenA 的宿主，随后成功 provide 另一个同名而不同对象身份的 tokenB。

红测：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts:173` 和 181 行。预期 resource-limit / definition-conflict，实际两次均成功。

影响：企业插件的可选集成仍持有定义对象，却不受根预算和名称唯一性管理。同名定义可以在同宿主代表不同能力，诊断按名称表达但装配按对象表达，破坏可审计的统一契约。这里没有证明跨定义的权限被直接窃取；身份冲突和预算绕过已经足以判定违约。

修复方向：定义生命周期统一管理 manifest、提供者、固定绑定和清理引用；装配规划预留所有实际引用的定义名称与身份，在失败回滚和卸载中按引用关系释放。optional 缺席依然绑定 null，登记定义引用不应把缺席能力动态补齐。

## 3. P2，新架构观察：声明的分层方向没有落到模块职责与检查工具

分类：架构边界漂移及修复耦合风险；没有声称导入环已造成运行故障。

位置：

- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/ARCHITECTURE.md:57` 明确声明生命周期层在 context 之下，底层不能反向导入 context 工厂。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/tasks/start-work.ts:5` 反向导入 createInvocation。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/create-invocation.ts:7` 导入 spawnTask；`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/tasks/spawn-task.ts:4` 又导入 startWork，形成运行时导入环。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/effects/release-effect.ts:5` 反向导入 createDependencyContext，后者直接依赖 service/chain/guard 执行机制。
- `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/scripts/check-kernel.ts:13` 仅禁止外部包和私有测试导入，不检查文档约定的内部层次，所以本轮 lint 的“57 kernel source files passed”不证明分层成立。

具体风险：Invocation 不只是数据工厂，它同时实施 bind 权限、resourceOwner 资源登记、spawn/wait 和释放；底层 startWork 必须回到 context 才能执行任何回调。Capability 创建、调用状态和生命周期终结共管同一事实。以后修复来源、撤销、清理能力和作用域委派时需要横跨这条环，不能依据文档把某一层替换成孤立模块。

修复方向：将公共 Context facade 的组合职责与受管工作/能力委派职责分开，围绕工作生命期及可撤销 capability 形成一个明确内部边界；需要反向接入的执行能力用内部窄接口或装配注入表达。先写清真实的依赖方向，再把其允许边写进现有检查工具。不要仅移动文件隐藏导入环，也不要为每个调用增加抽象层。

## 4. 架构选择成立：外部组合不需要扩大 core 的领域边界

分类：正向验收及能力边界判断，不是缺陷。

位置：公开导出 `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/index.ts:1`；受控绑定 `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/create-invocation.ts:20`；资源归属 `/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/tasks/start-work.ts:49`。

正测一只导入公开 index.ts，在两个独立 scope 中装配各自的入口服务、guard、chain、恢复中间件和记录服务。拒绝请求不进入记录；允许请求经过顺序恢复后分别形成独立记录；嵌套调用的直接来源为 execution、执行者为 ledger、resourceOwner 为各自 scope 的宿主消费方。关闭第一个 scope 释放其调用所创建资源，第二个继续执行；第一个旧门面失败。所有领域 token、业务状态、拒绝条件和恢复判断均来自测试中的外部 Plugin 对象。

正测二在插件创建的子 scope 中使用已声明祖先依赖，并拒绝通过 call.bind(siblingContext) 获取兄弟插件的 restricted 能力；普通插件的 Context 没有 load/dispose。它与第 1 项构成对照：一般依赖委派可用，自身提供能力的委派存在缺口。

测试位置：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts:32` 和 127 行，均通过。

企业业务可以把模型上下文、提示词/skill/压缩、审批状态、身份映射、持久记录、投影与恢复放在服务和插件契约中；本轮没有发现必须把这些领域类型塞进 core 才能调用的阻碍。Guard 需要受控入口主动调用，公开原始执行服务仍会被绕过；这是外部业务 API 的授权责任。相同进程的可信插件模型也明确排除了敌意代码沙箱。不要把本轮进程内组合测试扩大解释为持久恢复、跨进程可靠执行或租户隔离已经验收。

## 验证记录

新增文件：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2/core/src/context/__test__/architecture-boundaries.review.test.ts`，5 个用例，只导入公开 index.ts 和 Vitest，没有私有 helper/registry 导入、skip、配置修改或代码注释。新增报告即本文件。构建及覆盖率输出仅落在该 worktree。

执行 cwd：`/Users/wrr/.codex/worktrees/core-review-boundaries/x-harness/packages/v2`。

| 命令 | 实际结果 |
| --- | --- |
| `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts core/src/context/__test__/architecture-boundaries.review.test.ts` | 5 例：2 通过、3 失败，退出码 1 |
| `bun run typecheck` | 通过；18 个类型负例拒绝，23 个文档示例通过公开 API 类型检查 |
| `bun run lint` | 通过；0 error、0 warning；57 个生产源文件通过现有边界检查 |
| `bun run build` | 通过；55 个模块，浏览器目标 index.js 76.11 KB |
| `bun run test` | 14 文件：13 通过、1 失败；180 例：177 通过、3 失败，退出码 1 |
| `bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.reportOnFailure=true` | 同样 180 例：177 通过、3 失败；仅增加失败运行的覆盖率报告输出，没有改变断言或门禁 |

最终断言调整为完整 Result 对比后再次执行 typecheck/lint，均通过。3 个失败均来自新增审查红测，旧 175 个用例仍通过。没有把旧用例通过、构建通过或覆盖率数值描述成四门全绿。

失败运行实测覆盖率：语句 90.75%（1276/1406）、分支 89.07%（864/970）、函数 94.59%（210/222）、行 96.43%（1000/1037）。`vitest.config.ts` 没有配置 thresholds；因此这些是覆盖率数值，不是“覆盖率门禁达标”的证明。

## 限制与未验证事项

- 本轮没有修复生产代码，因此红测保留真实失败。已有审查另外 12 组问题不在本报告重新验收范围，不能据本轮正测视为已消除。
- 正测中的记录是由外部插件持有的内存状态，恢复是可控失败后的顺序链重试；没有验证真实数据库事务、进程崩溃、检查点恢复、未知副作用查询或幂等去重。
- 没有验证敌意代码隔离、多进程执行、外部认证、真实租户身份策略、模型/工具网络 I/O、生产负载或 GC。
- worktree 中不存在 fixtures 目录；文档实例组合示例通过类型检查，但这不等于文档列举的企业应用旅程已经运行验收。
- 没有执行旧工程或 e2e main；生产源码只读，没有 commit/push。
