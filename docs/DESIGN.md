# x-harness 技术设计（讨论定案记录·总规范）

> 状态：**讨论中，未写实现代码**。本文档先于代码存在，随讨论演进；未标注「待讨论」的条目为当前定案。
> **本文是总规范**：愿景、铁律、判据、六件套分布、词表索引、消费面、决策记录、议程。**各内核件的具体契约单源在件文档**（§4 分布表），本文不代持。
> 技术栈：bun 1.4.2 + TypeScript strict + vitest + oxlint（workspace monorepo，`packages/*`）。
> 参考系：`deepseek-harness`（dsh）——**站在肩膀上，批判性继承，不复制**（见 §1.1 坑清单）；`my-agent`（契约沉淀来源，代码不迁移）。

---

## 1. 愿景与定位

- 目标：生产可用的通用 Agent harness——**让非开发者也能构建高可用的 agent**。
- 时代判断：AI 时代技术不是壁垒。写代码的成本趋近于零，真正的壁垒是「让一个不写代码的人也能可靠地组装、信任、运维一个 agent」。因此：**可用性（重试、预算、恢复、幂等）是内核的责任，不是使用者的责任**——非开发者写不出健壮代码没关系，harness 兜底。
- **everything-is-a-plugin**：没有特权内核可 patch。扩展 x-harness = 在其他插件旁边挂一个插件；注册即 effect，插件卸载时按序回卷。
- 内核只定义规范：插件系统契约 + 必需服务。内核语义是核心资产：**自研最小内核**（不依赖 Cordis 等 Node 框架），bun 原生。

### 1.1 与 dsh 的关系：站在肩膀上，不复制

dsh 验证了几个我们吸收的核心分面：日志唯一事实 + 投影读面、无状态适配器注册表、setup 组合窗口、scoped per-agent 注册、「model-visible = logged」不变量。但它是实验版本，以下问题是我们明确要避开的坑：

| # | dsh 的坑 | 我们的回应 |
|---|---|---|
| P1 | **Cordis 框架税**：五派发模式 / realm·isolate / TypertRemoteService / HMR——写一个插件要先懂一套框架；满仓 declaration merging 的类型体操 | 自研最小内核，派发模式三种起步；token 注册即类型，全局接口合并克制使用（D14） |
| P2 | **配置层叠爆炸**：profile → bundle patch → user patch → overlay 四层 yml + cordis.yml / settings.yaml / session 事件三类，需要 `--dump-config` 才能推理最终树 | 配置层级最少化（D13）：一个 agent 定义 + 运行期事件，别无层叠 |
| P3 | **声明式 YAML 无编译期类型**：schemastery 校验 ≠ TS 类型，agents[] 与 preset 子树在 yml 里，错误启动时才爆炸 | 定义即结构化数据 + 装配期静态校验器，错误说人话、提前爆炸（§2 派生原则） |
| P4 | **为桌面热替换付内核复杂度**：prepared-call 代际绑定 / 单次派发 / 原子 replace 都是 HMR 竞态的补丁；agent 场景的核心是长会话可靠运行，不是热更新 | 无 HMR。prepareCall 保留「解析即快照」的简单语义，不建热替换协议（LLM.md §1） |
| P5 | **loop 仍是特权层**：docs 自己立规矩「改 loop 必须改 architecture.md」——理解成本高，扩展者绕着走 | turn/step 语义写死在本规范（驱动可换、语义不可换），loop 是默认驱动插件 |
| P6 | **可用性不是一等公民**：重试是一个可选插件、计量是 token-meter、崩溃恢复散在 persistence——没有「非开发者写的东西也可靠」的兜底故事 | 可用性内建（D12）：重试/预算上限/崩溃恢复/幂等是内核出厂默认，插件声明意图而非实现可靠性 |
| P7 | **非开发者路径缺失**：扩展单元 = TypeScript 插件，「写一个插件」对非开发者仍是编程 | 分层定义（D11）：L0 声明式优先——描述意图，AI/harness 编译成插件组合 |
| P8 | **包爆炸**：40+ 包、core 又拆 6 包，fork 与导航成本高 | 单包模块边界起步（D9），边界长硬再拆 |

### 1.2 使用者分层（规范分别服务）

| 层 | 使用者 | 做什么 | 规范面 |
|---|---|---|---|
| **L0** | 非开发者 | **声明**一个 agent：意图、工具清单、模型偏好、权限档、预算——一段结构化描述，甚至由对话生成 | 声明式定义格式 + 装配期校验器（形状待讨论，见 §8） |
| **L1** | 配置者 | **组合**现成插件成 preset，调参数 | preset 组合协议 |
| **L2** | 开发者 | **写插件**：工具、提示词段、行为钩子、适配器 | 插件协议（注册面 + 事件词表 + setup 窗口） |
| **L3** | 平台宿主 | **换底座**：存储、适配器、进程模型、凭据 | 服务契约 + 持久化端口 + 适配器注册表 |

「写一个插件 = 构建一个 agent」是 L2 的口号；对 L0 口号是「**填一份定义 = 得到一个生产可用的 agent**」。两层共享同一个内核规范——L0 的声明最终也编译成插件组合，没有旁路。

### 1.3 发行分层：内核版与通用版

- **内核版（`@x-harness/core`）**：纯净——Context 原语、会话日志、LlmRuntime、Agent registry + 默认 loop 驱动。零策略、零默认插件。面向要完全掌控底座的开发者（L2/L3）。
- **通用版（`@x-harness/standard`，agent 必备插件版）**：内核 + 预组装的必备插件，开箱即生产可用——异常重试（退避/断路）、预算（token/费用/步数/时长上限与超限熔断）、恢复（崩溃后 resume/会话重建）、幂等（工具调用重放保护），以及基础提示词段、权限默认档、上下文压缩、fs 持久化端口实现（D17）。面向直接使用者（L0/L1）；L0 声明的编译产物默认装配通用版。
- 通用版**没有特权**：它只是一个策展的插件组合包，与用户自组插件走同一协议；移除或替换其中任何插件都合法。
- **内核契约完备性试金石**：重试/预算/恢复/幂等必须能作为纯插件实现。若某项可靠性必须写死进 loop 才能工作，说明内核契约面有缺陷——修契约，不破例。挂靠面见 §3.5。

## 2. 铁律（SPEC 之根）

三条从第一天生效，一切实现接受它们的约束：

- **L1 日志是唯一事实源**：一切运行期可变状态（模型选择、权限等级、思考档、todo、收件箱）都是**读时折叠（fold-on-read）的派生值**。不存在第二事实源——没有带内部状态再靠动词同步镜像的服务实例，没有回放/应用阶段，没有状态机编排。
- **L2 model-visible = logged**：任何进入模型请求的内容（system、messages、tools、拨号 config）都必须能从会话日志重建。
- **L3 append-only**：事件不改不删；折叠是唯一读法；事件 payload 深冻结（只读事实）。

派生原则（与铁律同级的硬约束）：

- **流错误契约**：`stream` 绝不 throw；错误编码为终态 chunk；垃圾输入降级为空形态，不崩溃。
- **权限链不可绕过**：一切工具执行路径必须穿过权限/审批管线；被执法者不能替换执法机制。
- **构造面收敛**：内核不新增构造参数，只新增服务契约。一切实现物从「插件」这一扇门进来。
- **可用性内建于通用版**：重试、预算上限、崩溃恢复、幂等由通用版（§1.3）出厂预装，插件声明意图而非实现可靠性——非开发者交付物的健壮性由发行版兜底（回应 dsh 坑 P6）。内核版保持纯净零策略；内核契约以「可靠性可全插件化」为完备性试金石。
- **定义可校验、错误说人话**：一切声明式定义（L0/L1）在装配期静态校验（工具存在性、模型可达、权限词表、预算上限），拒绝运行期深处爆炸；错误信息面向人（与 AI）可读（回应 dsh 坑 P2/P3）。
- **结果用判别联合**：`{ ok: true; ... } | { ok: false; reason }`，不抛业务异常。

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ 宿主（CLI / server / 测试装置）——组装插件、提供配置、订阅事件  │
├─────────────────────────────────────────────────────────────┤
│ 通用版（@x-harness/standard，策展组合无特权）                  │
│   llm-retry · budget · recovery · idempotency ·               │
│   基础 prompt 段 · 权限默认档 · 压缩 · fs 持久化 —— L0 默认装配 │
├─────────────────────────────────────────────────────────────┤
│ 插件世界（一切策略与实现，与通用版插件平权）                    │
│   llm 适配器插件（pi / faux）· 工具插件 · system-prompt 插件   │
│   权限/审批插件 · 子代理插件 · 用户 agent 插件 …               │
├─────────────────────────────────────────────────────────────┤
│ 内核壳（内核版 @x-harness/core，纯净机制，不可替换的部分）       │
│   Context 原语（服务注册 / 事件派发 / scope / effect 回卷）      │
│   Session 日志（append-only + 折叠读面 + 持久化端口）           │
│   LlmRuntime（无状态适配器注册表 + prepareCall 快照）           │
│   Agent registry + 默认驱动 agent-loop（turn/step/配置瀑布）    │
│   工具执行管线（权限/审批挂点的执法通道）                        │
└─────────────────────────────────────────────────────────────┘
```

内核壳对「什么是 session、什么是模型、工具怎么存」失明——它只认契约。规范不只定义「允许什么」，还定义「保证什么」（铁律 + 派生原则）。

### 3.1 进内核的判据：五条测试

一个东西进内核，当且仅当通过以下之一：

1. **自举测试**：插件踩在它上面才能存在（Context 原语——没有它连「注册插件」都做不到）；
2. **事实保管测试**：保管不可撒谎的事实（会话日志——任何第二事实源都会漂移）；
3. **执法测试**：不可以被执法者替换的执法通道（工具管线次序、ask 必须决出）；
4. **词表测试**：所有参与方的公共语言（StreamChunk、事件词表、stopReason 语义）；
5. **本质性测试（词表专用）**：每个词条必须回答「它底下的更原语动词是什么」——存在更原语动词、且当前词条只是它的组合时，词条降级为插件组合（战例：`compaction` → `history/splice`，D19）。

过不了任何一条的是策略或实现物，出去。负检验 = 试金石（§1.3）：重试/预算/恢复/幂等必须能在内核之外实现，内核只欠挂靠面。

### 3.2 内核六件套（实现清单）

| 件 | 测试 | 内容 | 规格 |
|---|---|---|---|
| **A. Context 原语** | 自举 | 服务注册表、事件总线（emit/waterfall/serial/guard）、scope、effect 账本、插件加载器 | [CONTEXT.md](./CONTEXT.md) |
| **B. Session 日志** | 事实保管 | 事件构造、词条形状门、append 三步、折叠读面、最小事件集（9 条）、持久化端口 | [SESSION.md](./SESSION.md) |
| **C. LlmRuntime + 流词表** | 词表 | 适配器注册表、resolveModel、prepareCall（解析即快照）、StreamChunk 协议、思考档词表 | [LLM.md](./LLM.md) |
| **D. Agent registry + create** | — | 极小公共面、setup 组合窗口（composes never drives）、发布次序 | [AGENT.md](./AGENT.md) |
| **E. agent-loop 默认驱动** | 词表（状态机语义） | turn/step 事件序、读链提案 + compose 瀑布、消息投影、quiescence/steer/cancel、step 否决点、assistant 落账 | [LOOP.md](./LOOP.md) |
| **F. 工具执行管线** | 执法 | ToolDefinition 契约、次序执法（pre → ask 必须决出 → guard → execute → post → result）、answerer 端口 | [TOOLS.md](./TOOLS.md) |

驱动可换、语义不可换：E 的 turn/step 语义写死在本规范，替换驱动（另装 loop 插件）不得改变事件序与铁律。

### 3.3 负空间（内核明确不实现）

重试/预算/恢复/幂等（→ standard 四件套）；fs 持久化端口实现（→ standard，core 仅接口 + memory 实现，D17）；权限策略与审批 UI（→ 插件，内核只有 ask 桥）；system-prompt 内容与组装（→ 纯插件化，D16）；压缩/子代理/路由/计量（→ 插件）；wire 适配器（→ 适配器插件）；CLI/进程模型/凭据注入（→ 宿主）。

### 3.4 内核词表索引（域词表单源在各件文档）

> 机制与规则（token 形态、派发语义、单级制、冻结策略、自举域与通用信封）在 [CONTEXT.md](./CONTEXT.md)。**各域 token 的载荷与冻结标注归 owning 件的文档**——本表只是索引。代码导出可集中于 `@x-harness/core/vocab`（一个模块），文档归属按件分域，两回事。总线词表共 24 token。

| 域 | owning 件 | token 数 | 归档 |
|---|---|---|---|
| 自举域 + 通用信封 | Context | 5 + 1 | [CONTEXT.md §6](./CONTEXT.md) |
| 会话域 | Session | 1 | [SESSION.md §4](./SESSION.md) |
| Agent lifecycle 域 | Agent registry | 3 | [AGENT.md §4](./AGENT.md) |
| loop 拦截域 | agent-loop | 3 | [LOOP.md §3](./LOOP.md) |
| llm 域 | LlmRuntime | 2 | [LLM.md §4](./LLM.md) |
| 工具执法域 | 工具管线 | 9 | [TOOLS.md §5](./TOOLS.md) |

词表扩张纪律：新内核 token（含新通用信封）必须先改 owning 件文档再落码（方案与代码同变）。

### 3.5 分层路由与消费面

**总线事件 vs 会话事件（易混，特意对照）**：

| | 总线事件（§3.4 索引的词表） | 会话事件（WAL，SESSION.md） |
|---|---|---|
| 寿命 | 进程内、瞬时 | 持久、append-only |
| 角色 | 观察（emit）与拦截（waterfall/guard/serial） | 事实账本（唯一事实源，L1） |
| 消费方式 | 监听器实时收；错过不补 | `session.events()` 随时全量读 + fold |
| 例子 | `llm/chunk`（流式 UI） | `assistant/message`（含 usage 的账本事实） |
| 桥 | 每次 append 广播 `session/event` | — |

规则：**要重建就落会话（L2：model-visible = logged），要响应就挂总线**。同一个事实可以两侧都有（执行结果：`tool/result` 总线广播 + 会话落账），但事实的定义只在会话侧。

**通信模式选择器（服务间/插件间通信的四归路）**：

| 你要做什么 | 用什么 |
|---|---|
| 要回答（查询状态、下发命令） | **服务**（typed call——跨插件契约的唯一类型安全通道） |
| 要大家都看见（广播观察） | **emit token**（错误隔离，不在路径上） |
| 要改流程（拦截改写/否决/串行窗口） | **waterfall / guard / serial**（在路径上，错误有后果） |
| 要重建（resume/审计/模型可见） | **会话 append**（持久事实） |
| 插件私有观察 / 私有持久 | `plugin/event` 信封 / `plugin/record` 槽 |

**旧词表全量路由（my-agent EmitEventName → 本词表）**：

| 旧词 | 新归宿 |
|---|---|
| `assistant/stream`（含推理流） | `llm/chunk`（reasoning 增量是 StreamChunk 变体） |
| `tool/start` / `tool/result` / `tool/progress` | 同名保留（progress 生产者 = 管线经 `exec.progress()`，插件不直发内核 token） |
| `turn/end` | 会话 `turn/end` → `session/event` 广播 |
| `turn/start`、`step/start·end`、`request/start`、`inbox/spliced`、`compaction` | **派生**：turn 起点 = user/message 首发；step 边界 = header↔assistant 配对；request 观察 = header 广播；steer = 同 turnId 的 user/message；压缩 = splice |
| `permission/decision` | `approval/asked↔decided` 审计对；合规级持久审计归权限插件记录槽 |
| `llm/retry` | llm-retry 插件信封（要审计加记录槽）——重试是插件域（CONTEXT.md C9） |
| `hook/error` | 错误 sink（不设 token：为监听器错误发事件可能再失败，递归）；waterfall 错误 = 派发 reject |
| `agents/spawned·idle·terminal` | 泛化 `agent/created·idle·terminated` |
| `agents/state·evicted·user-injected` | agents 插件信封（任务级语义是插件私有） |
| `agents/permission-ask` | **免新词**：子 scope 的 `approval/asked` 经 chain-up 天然上达父链 |

**UI 层接收面（完整食谱——订阅 root 上 11 样，其余全部派生）**：`session/event`（一切事实）· `llm/chunk` · `tool/progress`（两条流）· `tool/start` + `tool/result`（工具动画对）· `approval/asked` + `approval/decided`（审批对）· `agent/created` + `agent/idle` + `agent/terminated`（agent 池）· `plugin/event`（插件 toast 通用渲染）。

**观察面完备性（成对律）**：UI 类观察者的 start/end 需求由总线 emit 成对满足——`tool/start ↔ tool/result`、`approval/asked ↔ approval/decided`、`agent/created ↔ agent/terminated`；step/turn 起点免 token（step 起点 = `session/event` 的 request/header 广播，turn 起点 = user/message 广播）。**观察者绝不用 waterfall 中间件**（中间件在关键路径上，其 bug 会打断执行）。会话最小化（D20）只约束持久事实，不约束观察面：两者消费者不同（重建者 vs 实时渲染者）。

**试金石映射（可靠性四件的挂靠面）**：

| 可靠性件（standard） | 挂靠面 |
|---|---|
| llm-retry | `llm/stream` waterfall（串行重调） |
| budget | `agent/pre-step`（否决）+ `session/event`（usage 账本折叠） |
| recovery | `session/event` + 持久化端口 + fold（无总线依赖） |
| idempotency | `tool/execute` waterfall + `tool/result`（toolCallId 账本核对） |

## 4. 内核件规格分布

六件套各有专属规格文档（§3.2 表），职责边界如下——**本文不代持件级契约**：

- **A Context**（[CONTEXT.md](./CONTEXT.md)）：自举底座——两种名字（服务/事件 token）、四种派发模式、scope 层链、effect 账本、插件加载器、词表单级制规则、自举域与通用信封、用法预演（验收剧本）。
- **B Session**（[SESSION.md](./SESSION.md)）：事实保管——事件契约、折叠读面、最小事件集（9 条）、`session/event` 桥、持久化端口。
- **C LlmRuntime**（[LLM.md](./LLM.md)）：词表所有者——无状态适配器注册表、prepareCall 解析即快照、StreamChunk 协议、思考档、`llm/stream` 与 `llm/chunk`。
- **D Agent**（[AGENT.md](./AGENT.md)）：registry 与组合窗口——极小公共面、create + setup、子代理继承、lifecycle 词表。
- **E agent-loop**（[LOOP.md](./LOOP.md)）：默认驱动——读链统一、运行期状态端到端时序、消息投影、quiescence/steer、拦截词表。
- **F 工具管线**（[TOOLS.md](./TOOLS.md)）：执法通道——执法次序、answerer 端口、ToolDefinition 骨架、注册遮蔽与调度、九 token 词表。

## 5. 包骨架与里程碑

```
packages/
  core/                   # 内核版（纯净）：零策略、零默认插件
    src/
      context/     # Context 原语：服务注册/事件派发/scope/effect 回卷
      session/     # append-only 日志 + 形状门 + 广播 + 折叠读面 + 持久化端口（接口 + memory）
      llm/         # LlmRuntime：适配器注册表 / resolveModel / prepareCall
      agent/       # Agent 接口 + registry + create（setup 窗口）
      agent-loop/  # 默认驱动：turn/step/请求配置瀑布/quiescence/steer
  standard/         # 通用版（M4）：必备插件策展 + 组装入口——
                    #   llm-retry / budget / recovery / idempotency /
                    #   基础 prompt 段 / 权限默认档 / 压缩 / fs 持久化端口实现（D17）；
                    #   无特权，纯插件组合包
  llm-faux/         # 确定性测试适配器（依赖 core，属内核测试地基非通用版）
```

core 单包起步，模块边界即未来的包边界（session、llm、agent-loop 长硬后拆包）。

- **M1 地基（内核版）**：context/ + session/（memory 端口）+ 全套单测 + 各件文档收口为施工图。
- **M2 脊柱（内核版）**：llm/ runtime + llm-faux；StreamChunk 词表定稿（LLM.md §6）。
- **M3 行走骨架（内核版）**：agent/ + agent-loop/ 最小驱动——faux 跑通完整 turn，读链在 loop 立起来。**试金石首次验收**：验证四项可靠性挂靠面在内核上可用。
- **M4 通用版发行**：llm-retry / budget / recovery / idempotency 四件 + 基础提示词段 + 权限默认档 + 压缩 + fs 端口；L0 声明式定义在此层落装配（形状依 §8 讨论定稿）。
- M5+：工具生态、子代理、宿主形态（依讨论进度排程）。

每程四门全绿（oxlint 0-0 / tsc / build / vitest+覆盖率）再进下一程。开发纪律沿用：无 TODO 交付、不留兼容路径、覆盖率只升不降。

## 6. 从 my-agent 移植清单

**带走（契约重写为新实现）**：流错误契约（绝不 throw、终态 chunk）；WAL 事件词表概念与「消息即账本」（usage/实际拨号方随 assistant 事件落账）；request/header 每请求信封；思考档词表与 budget；faux 确定性适配器；pi-ai wire 外包；turn/step/quiescence/steer 语义；结果判别联合风格。

**留下（判死，不迁移）**：AgentConfig 胖构造（model+providers 双参数、settings/logger/toolWhitelist/commands 参数位）；settings 快照通道与 SettingsReader 面；有状态 Llm（setModel/forModel/dial 动词）；StateDomain/stateStore 状态机；每 step 从 WAL 解析拨号的 loop 内逻辑；宿主裸写 WAL + 内核尾折轮询的双径协议；resolveBareModel（其语义并入写侧校验与 options 继承）。

## 7. 决策记录

| # | 决策 | 判死的备选 | 理由 |
|---|---|---|---|
| D1 | Agent 构造面收敛为「插件 + 数据 + setup」 | `model + providers` 双参数 | 实现物不该穿构造面；agent 只需一个 LLM 面 |
| D2 | 两类换模型分离：会话级选择（事件+折叠）vs 请求级路由（适配器内部） | 混在 compose 改写 | 生命周期不同：持久 vs 瞬时 |
| D3 | 拨号 = 读时折叠，不落实例状态 | setDial/setModel 动词 + 实例镜像 + resume 回放 | 双事实源需要同步/回放/降级编排；折叠即应用，消灭该问题类 |
| D4 | LLM = 无状态适配器注册表 + prepareCall 快照 | 单一有状态 Llm 实例 | 同 D3；快照防解析与派发错配 |
| D5 | 读链统一（提案→瀑布→解析），非写径统一 | compose 改写强制转持久 setModel | 持久与瞬时两层天然汇入同一读链 |
| D6 | 运行期状态 = session 事件 + 折叠（model/permission/thinking 同机制） | StateDomain 五件套状态机 | 单一机制覆盖所有状态域；降级 = 链回退，无需编排 |
| D7 | everything-is-a-plugin；session 日志/工具管线/loop 驱动为内核机制 | session/dispatch 也做成可替换插件 | 插件踩在日志上运行（自举）；工具管线是权限执法通道（安全）；这两处的可换维度走端口 |
| D8 | 自研最小内核 | 依赖/vendore Cordis | 内核语义是核心资产；所需子集小；dsh 自己维护 vendor 分支说明非免费 |
| D9 | core 单包起步，模块边界=未来包边界 | 直接拆 dsh 式多包 | 速度优先，边界长硬再拆 |
| D10 | **词表单级**：总线只携带内核 token（CONTEXT.md C1/C9）——插件以值参与（`plugin/event` 信封 / 会话 `plugin/record` 记录槽），不自铸词条 | 中央封闭词表；全局接口合并（dsh/my-agent）；插件自铸 token 自由域 | 词表 = 规范 = 有限可学；UI 一次订阅渲染一切；前缀执法机制删除 |
| D11 | 分层定义：L0 声明式 / L1 组合 / L2 插件 / L3 端口，共享同一内核规范 | 扩展单元 = TS 插件（dsh） | 非开发者入口是声明不是代码；L0 编译成插件组合，无旁路 |
| D12 | 可用性内建于通用版：必备可靠性插件出厂预装；内核版纯净零策略；内核契约以「可靠性可全插件化」为完备性试金石 | 可靠性散在可选插件（dsh）或硬编码进内核 | 非开发者写不出健壮代码，发行版兜底；但内核硬编码 = 特权代码，违反 everything-is-a-plugin |
| D13 | 配置层级最少化：agent 定义 + 运行期事件两种 | profile/bundle/patch/overlay 四层 yml 叠加（dsh） | 层叠组合爆炸需 `--dump-config` 才能推理 |
| D14 | 开放词表克制：**token 注册即类型，内核自身也不用全局接口合并**（C1 落定后此条与 D10 合流） | 满仓接口合并（dsh Context/Events/EventMap/ContentBlockMap） | 全局合并的类型定位与编译成本；框架税（坑 P1） |
| D15 | 两层发行：内核版（core，纯净）+ 通用版（standard，必备插件预组装，无特权） | 单层发行（dsh 的 base bundle 是 yml 清单，非包级产品分层） | 开发者要纯度、直接用户要可用性，两类需求两层满足；通用版 = 策展组合，不破坏插件平权 |
| D16 | system-prompt 纯插件化：内核无 prompt 服务，system 初值 = 上次 request/header 或空串，插件经 compose 瀑布盖写；基础段归 standard | 内核 systemPrompt 服务（段落注册+组装次序+变量回填，dsh 同款） | 内核最瘦；次序与变量是策略；M3 骨架无需 prompt 插件即可跑 |
| D17 | fs 持久化端口实现归 standard；core 仅接口 + memory 实现 | core 附带 fs 实现 | 内核表面积最小；代价：纯内核版只跑内存会话，落盘装 standard 或自写端口 |
| D18 | 注册面运行期开放 + 快照语义：一切注册经 effect 账本；变更于下一次组装/派发点生效，在飞单元用启动时快照（工具表快照落 request/header） | 加载期注册 + 运行期冻结 | 支持自修改 agent/运行期加热工具；快照语义消解在飞竞态（M3 骨架假设之一） |
| D19 | **投影原语 `history/splice`**：内核只拥有「可见性怎么折」一条投影语义（区间不可见 + 内联替代）；压缩完全插件化——触发策略、摘要生成（side 调用经 llm/stream dispatch）、一次 splice 追加 | 内核 `compaction` 事件（对抗走查后否决——把「压缩」概念不当抬进词表）；my-agent 式世代事件 | 同一原语服务压缩/滑窗/上下文编辑/fresh start；内核知道得更少；世代是派生值不是存储事实 |
| D20 | **最小事件集（9 条）**：删 `tool/call`（tool_use 块已在 assistant/message，同一事实不落两处）、删 `turn/start`（= 共享 turnId 的首个事件）、删 `step/start·end`（边界 = header↔assistant 配对；失败 = 悬空 header + turn/end）；保 `turn/end`（end_turn ≠ 结束，steer 可续航，终态不可推导只能自述） | 13 条全集（想到一个事实记一个词条） | 本质性测试（§3.1 第 5 条）的系统性推导：删掉后有折叠读面断 = 本质，全部可推导 = 冗余 |
| D22 | **差距批进内核（用户裁决）**：parallel / waitFor / 装配 join / prepend 四项对照差距趁 Context 无下游消费者时直接落地——后补即动公共面；HMR 不进内核（运行期装卸已有 + 版本热换 = unload+load + 状态经宿主服务迁移） | 留给插件层组合（先前倾向）；照抄 Cordis fiber 状态机 | 组合可达 ≠ 免动内核：公共面后补成本高于当下落地；HMR 的生产价值已被 resume + 装卸组合覆盖 |
| D21 | **词表与规格文档归属**：每内核件独立成篇（CONTEXT/SESSION/LLM/LOOP/AGENT/TOOLS.md），件级契约与域词表单源在件文档；DESIGN 只持总规范（判据/索引/消费面/决策/议程）；代码导出可集中（`core/vocab`），文档归属按件——两回事 | 单一大文档；或 DESIGN 代持全部件契约（先前形态，已否决） | 文档镜像代码的 ownership：谁拥有谁定义；DESIGN 可读、件文档可施工 |

## 8. 待讨论清单（下一程议程）

**声明式 agent 定义（L0 入口——非开发者路径的核心，当前最高优先）**
- 定义形状：意图描述 / 工具清单（引用 + 参数约束）/ 模型偏好 / 权限档 / 预算上限——载体是结构化文件（markdown frontmatter？JSON？）还是纯数据 + 对话生成
- 校验器规则集：工具存在性、模型可达、权限词表、预算上限——装配期人话报错
- 定义 → 插件组合的编译映射：谁编译（harness 内建？AI 参与？），编译产物可审（L0 用户能看懂组合结果）

**件级未决（单源在各件文档的待讨论节）**
- [CONTEXT.md §8](./CONTEXT.md)：ScopeFilter 形状、chunk 背压、waterfall 挂起超时、token 元数据
- [SESSION.md §6](./SESSION.md)：9 条事件字段级形状、一 session 一 writer、schema 版本化
- [LLM.md §6](./LLM.md)：StreamChunk 全集、三形关系（CallConfig/Request/Draft）、思考档报错面
- [LOOP.md §5](./LOOP.md)：inbox/steer 时序、quiescence 判定、预算拒绝落点、system 指纹
- [AGENT.md §5](./AGENT.md)：preset 组合协议、ScopeFilter 协同
- [TOOLS.md §7](./TOOLS.md)：ToolDefinition 细节、ToolResult 形状、并发调度器、guard 时点

**跨件议题（本档持有）**
- 权限与审批：approval ask 流的插件契约、permission/mode 词表与 presets、sandbox 模式要不要
- 上下文管理：压缩触发策略、token-meter（成本账本、估算规则）
- 持久化与生命周期：fs 布局与锁、崩溃恢复、resume/fork(seed 前缀)、多进程宿主模型与凭据注入
- 观察面与配置：事件 → UI/transcript 投影、secret redaction、进程级配置面（插件工厂参数 vs settings 服务——当前倾向前者，dsh 后者）、CLI 形态与唯一入口纪律
- 测试与质量：faux 剧本语言、行走骨架 e2e、覆盖率门禁数字、四门流水线
