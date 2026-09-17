# Context 原语设计（自举底座）

> 状态：**讨论中，未写实现代码**。本文是 [DESIGN.md](./DESIGN.md) §3.2 内核六件套之 A 件的展开——独立成篇，因为它是一切的基石：插件存在之前，只有 Context。
> 核心契约一句话：**Context 上只有两种名字——服务 token 与事件 token，都注册即类型；一切注册经 effect 账本可回卷。**
> 本文只持有 Context 自身：机制规则 + 自举域词表 + 通用信封。**各内核件的域词表与件级契约单源在件文档**（SESSION/LLM/LOOP/AGENT/TOOLS.md；DESIGN §3.4 为索引）——词表归 owning 件，Context 不代持。

---

## 0. 定位与不变量

- **自举测试的唯一通过者**：没有它连「注册插件」都做不到，因此它不依赖任何其他内核件（包括 logger——见 §2.4 错误 sink）。
- 不变量（实现必须保证，违反即缺陷）：
  - I1 一切注册可回卷（effect 账本，逆序 dispose）；
  - I2 waterfall 监听器必须调用 `next` **至少一次**；串行重调合法（重试语义的核心机制），并发调用 throw（§2.2）；
  - I3 emit 监听器错误隔离，单个监听器不得破坏派发；
  - I4 payload 冻结策略按词表执行（§2.3）；
  - I5 词表单级：总线只携带内核 token，插件以**值**参与（观察信封 / 会话记录槽），不自铸词条（§6.2）。

## 1. 服务注册表

```ts
export interface ServiceToken<T> { readonly kind: "service"; readonly name: string }
export function defineService<T>(name: string): ServiceToken<T>

// Context 面
provide<T>(token: ServiceToken<T>, impl: T): Disposer
use<T>(token: ServiceToken<T>): T                 // 链上最近提供；缺失 throw（fail-fast）
tryUse<T>(token: ServiceToken<T>): T | undefined
```

语义：

- **provide 同层同 token 重复 → throw**；不同层（scope）同 token 合法——子层遮蔽父层（§3）。
- **use 沿 scope 链 nearest-first 查找**，缺失即 throw 并报出 token 名与查找过的层——不降级、不返回空形态（缺服务是装配错误，不是运行期垃圾输入）。
- provide 成功后广播 `service/provided`（§6.1 自举域；observability；也支撑「可选依赖」模式：监听服务出现再接线，不需要 Cordis 式 inject 反应式）。

## 2. 事件总线

### 2.1 一切事件皆 token（修订 DESIGN D10/D14）

```ts
export interface EventToken<T>       { readonly kind: "event";     readonly mode: "emit";       readonly name: string;
                                        readonly freeze: "deep" | "shell" | "none" }
export interface WaterfallToken<I, O> { readonly kind: "waterfall"; readonly mode: "waterfall"; readonly name: string }
export interface SerialToken<T>      { readonly kind: "serial";  readonly mode: "serial";    readonly name: string }
export interface GuardToken<T>       { readonly kind: "guard";   readonly mode: "guard";     readonly name: string }

export function defineEvent<T>(name: string, opts?: { freeze?: "deep" | "shell" | "none" }): EventToken<T>
      // freeze 缺省 "deep"；"shell" = 只冻一级字段（信封类：plugin/event 壳冻结、data 原引用）；
      // "none" = 高频豁免（生产者约定构造即不可变）
export function defineWaterfall<I, O>(name: string): WaterfallToken<I, O>
export function defineSerial<T>(name: string): SerialToken<T>
export function defineGuard<T>(name: string): GuardToken<T>

/** 匿名链：无全局名不进词表，owner 持有并经服务共享（§6.2） */
export interface Chain<I, O> { dispatch(input: I): Promise<O> }

// Context 面
on<T>(token: EventToken<T>, listener: (payload: T) => void): Disposer
on<I, O>(token: WaterfallToken<I, O>, middleware: (input: I, next: (i: I) => Promise<O>) => Promise<O>): Disposer
on<T>(token: SerialToken<T>, listener: (payload: T) => Promise<void> | void): Disposer
on<T>(token: GuardToken<T>, listener: (payload: T) => Promise<GuardDeny | void> | GuardDeny | void): Disposer

emit<T>(token: EventToken<T>, payload: T): void
dispatch<I, O>(token: WaterfallToken<I, O>, input: I, final: (i: I) => Promise<O>): Promise<O>
dispatch<T>(token: SerialToken<T>, payload: T): Promise<void>
dispatch<T>(token: GuardToken<T>, payload: T): Promise<GuardDeny | undefined>

createChain<I, O>(final: (i: I) => Promise<O>): Chain<I, O>     // 匿名链：final 铸造时绑定
onChain<I, O>(chain: Chain<I, O>, middleware: ChainMiddleware<I, O>): Disposer  // 消费方注册，层归属消费方
```

- **派发模式编码在 token 里**：注册与派发模式不匹配在类型层即错；token 的泛型即载荷类型——**不需要 declaration merging，不需要中央 Events 接口，词表 = 导出的 token 常量集**（域词表分件归档：SESSION/LLM/LOOP/AGENT/TOOLS.md；DESIGN §3.4 为索引）。
- **waterfall 的 final 由域 owner 在 dispatch 时传入**（内核各件拥有自己的 final：loop 拥有 pre-step/compose 的放行与组装，llm 拥有真正的 stream 调用，工具管线拥有真正的 execute）——final 是「不被拦截吞掉的真实动作」。
- 同名 token 重复 define 不报错（跨插件隔离域时同名合法），但内核词表内名字唯一。

### 2.2 四种派发模式语义矩阵

| 模式 | 执行次序 | 短路 | 监听器抛错 | 冻结 | 同步/异步 |
|---|---|---|---|---|---|
| **emit** | 注册序，scope 链 root→leaf 并集 | 否 | **隔离**：捕获后进错误 sink，其余监听器照常 | 词表标注 | 同步（监听器不得 await，重活自排队） |
| **waterfall** | 洋葱：注册序包裹，final 最内层 | 合法（业务语义） | **派发失败**：Promise reject——拦截链是关键路径，坏监听器必须暴露 | 输入 deep | 异步 |
| **serial** | 注册序逐个 await | 否（全部执行——弃权不得跳过他人） | **隔离**（进 sink，继续下一个） | deep | 异步顺序 |
| **guard** | 注册序逐个 await，**全部执行不短路**——deny 与错误都不跳过他人（弃权/否决权结构性平等） | 结果 = 注册序**首个 deny 即终态**（执行不停止、结果已定）；只能否决，无 allow 可翻回 | **隔离**（坏守卫按弃权计——否则一个坏插件就能瘫痪否决链） | deep | 异步顺序 |

waterfall 的 `next` 纪律（I2）：返回时未调 → 派发结束 throw；**串行重调合法**——每次重调完整重执行链尾与 final（重试中间件的机制基础，dsh 同款）；并发调用 → 立即 throw。洋葱次序保证输入在链上可见的是「前一个监听器的产物」。**final 的可重执行性由 token owner 词表标注**：`llm/stream` 标注「可重执行」（每次 next 重调 = 真实重发）；纯函数 final（compose 等）天然可重调；不保证者标注「单次」，违者自责。

### 2.3 冻结策略

- 默认：**首次派发前 deep freeze**（含 waterfall 输入）；冻结对象在 strict mode 下被写入即 throw——天然 fail-fast。
- `shell`：只冻结一级字段——信封类词表用（`plugin/event`：壳冻结、`data` 保持原引用）。
- 豁免：高频流事件（如 `llm/chunk`、`tool/progress`）词表标注 `freeze: none`——每 chunk 深冻结的成本不可接受；豁免的事件由**生产者约定构造即不可变**（fresh object、不共享可变引用），词表显式标注以示信任边界。
- 容器边界：deep 档对 Map/Set/Date 等容器类**只冻结外壳**（内部条目不可变性由词目约定——与 none 豁免同级的信任边界）；环引用安全（seen 集终止）；预冻结外壳不阻断子代递归。
- 不可冻结值（AsyncIterable、函数引用）：所在词目标注 `none`。

### 2.4 错误 sink（而非 logger 服务）

总线工作时 logger 服务可能尚未注册（自举序），因此监听器错误的归宿是 **Context 创建时注入的 `onListenerError` 回调**（缺省写 stderr）。宿主可替换为自家的日志/遥测——这是宿主注入面，不是服务面。

### 2.5 重入与异步边界

- `emit` 同步可重入（监听器里再 emit 合法）；内核不做防递归保护，词表设计者自责。
- `emit` 监听器返回 Promise：不 await（不阻塞派发）；其 rejection 进错误 sink——防 unhandled rejection 崩溃进程（I3 的自然延伸：单个监听器的失败不得破坏进程）。要走有次序保证的异步链路用 serial/waterfall。

## 3. scope（层链）

```ts
scope(filter: ScopeFilter): Context   // 子层视图；返回值带 disposer
```

- **层链**：scope 之上有父层（直至 root）。子层注册打本层标记；`dispose` 只回卷本层 effect（逆序）。**scope 创建本身在父层登记 effect**——父层回卷自动收编未显式 dispose 的子层，无泄漏。
- **监听器：并集、root→leaf 次序，不遮蔽**——链上所有层的监听器都执行，根层先执行。事件是多播语义，遮蔽没有意义。
- **注册表（工具/适配器）与服务：nearest-first 遮蔽**——子层同名注册遮蔽祖先（scoped 工具 shadow 全局同名是 spawn 继承的基础）。单播语义才遮蔽。
- **定向派发（chain-up，全模式）**：在层 L 上派发（emit 与 waterfall/serial/guard dispatch），监听器/中间件的可见集 = **L 及其祖先链**；兄弟分支不可见。推论：**宿主在 root 监听即可看见全部后代 agent 的事件；agent 之间互相不可见**。
- scope 的 filter 形状（按 agentId？谓词？）待实现期定——语义先钉死如上。

## 4. effect 账本与 dispose

- `ctx.effect(disposer)`：disposer 可为 `void` 或 `Promise<void>`（异步收尾如持久化 flush 合法）。
- `ctx.dispose(): Promise<void>`：**串行逆序** await 本层全部 effect（含 provide/on 注册返回的 disposer）——后注册者先回卷，前一个回卷完成才回卷下一个。**回卷容错**：单个 disposer 抛错不中止回卷（I1 优先：其余 effects 必须全部回卷、状态推进到 disposed）；全部完成后若有错误，单个抛原错、多个抛 `AggregateError`。
- unwind 边界：dispose 开始后 `on/provide/effect` 的新增一律 throw；`waterfall/guard/serial` 的 dispatch 拒绝——**检查整条祖先链**（父层回卷中途的子层 dispatch 同属半拆态窗口）；`emit` 允许（清理过程可观察）。
- 层 dispose 不影响父层与兄弟层。

## 5. 插件加载器

```ts
export interface Plugin {
  name: string
  inject?: readonly string[]      // 依赖的插件名——加载序约束（topo）
  apply(ctx: Context): Disposer | void | Promise<Disposer | void>
}
```

- **config 走工厂闭包，不走 apply 参数**（D13/D16 的必然结论——无 settings 通道）：`createMyPlugin(options)` 返回 Plugin，options 闭包在内。
- `inject` 按插件名 topo 排序；**循环依赖 → 装配期 throw**；重名插件 → throw。
- `apply` 可异步；返回的 disposer 自动入 effect 账本。
- 加载完成逐个广播 `plugin/loaded`；apply 抛错 → `plugin/error` + 装配失败（整体回卷已加载的）。
- **卸载契约**：`loadPlugins` 返回与插件同序的卸载句柄（`Disposer[]`）——单插件卸载 = 逆序回卷其 **apply 期注册**（provide/on/onChain/effect + apply 返回的 disposer）；句柄幂等，且与层回卷共用 once 哨兵（层 dispose 兜底不双跑）；apply 之后的运行期注册归调用方层账本，随层回卷。**并发契约**：并发 loadPlugins 无互斥（检查是入口快照）——装配序列化是宿主责任。

## 6. 内核事件词表：Context 自身

### 6.1 token 清单（自举域 + 通用信封）

**自举域（Context 自身）**

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `service/provided` | emit（提供层 chain-up） | `{ service: string }` | deep | 服务出现（可选依赖接线用——监听者须在能看见提供者的层：root 或其祖先链；兄弟不可见，与 C3 一致） |
| `plugin/loaded` | emit | `{ plugin: string }` | deep | 加载完成 |
| `plugin/error` | emit | `{ plugin: string; error: string }` | deep | apply 失败（随后装配失败） |
| `context/disposing` | emit | `{}` | — | dispose 回卷开始前 |

**通用信封域（插件观察的唯一总线出口）**

| token | 模式 | 载荷 | 冻结 | 说明 |
|---|---|---|---|---|
| `plugin/event` | emit（agent 链或 root） | `{ plugin: string; kind: string; data: unknown; ts: number }` | **壳冻结**（一级字段 plugin/kind/ts/data 冻结；`data` 保持原引用——信任边界 = 不承诺不可变） | 插件瞬时观察的信封——UI/遥测订阅一次即可渲染一切插件观察，无需认识任何插件长尾 |

**其余五域（会话/Agent registry/loop 拦截/llm/工具执法）的 token 清单、载荷与冻结标注，单源归档于各 owning 件文档**（SESSION.md §4 / AGENT.md §4 / LOOP.md §3 / LLM.md §4 / TOOLS.md §5；DESIGN §3.4 为索引）——词表归 owning 件，本文不代持。

### 6.2 词表单级制（I5）

**总线只说内核语言：内核 token 是唯一词条，插件以值参与。** 插件的一切表达需求走四条路由，没有第五条：

| 需求 | 归宿 |
|---|---|
| 跨插件类型契约 | **服务**（typed call）——显式接口，不走事件 |
| 持久事实 | 会话记录槽 `plugin/record {plugin, kind, data}`（SESSION.md §3）——印章归插件名，形状门与类型化读取器由插件自带 |
| 瞬时观察 | `plugin/event` 信封（§6.1）——`kind` 是插件私有字符串，无全局注册 |
| 提供可被拦截的扩展点 | `ctx.createChain(final)` **匿名链**——无全局名字不进词表，经插件自己的服务共享；消费方经 **`ctx.onChain(chain, mw)`** 注册，层归属消费方、随消费方层回卷（I1 闭合）；final 铸造时绑定 |

**为什么不走「插件自铸 token」**：词表 = 规范 = 有限、可审计、可学完；自铸词条让宿主 UI 必须认识每个插件的长尾（违背 L0「看得懂发生了什么」）；前缀执法机制（归属校验、防伪造）整个不需要存在。

**为什么通用不等于开放**：通用事件的载荷形状必须内核拥有（判别联合或带判别字段）；插件私有数据只进 `data` 信任边界。开放载荷（any/unknown 裸奔）会退回 stringly-typed，丢掉 token 注册即类型的收益——类型安全的让渡仅限信封 `data`，由「跨插件契约走服务」补偿。

**词表扩张纪律**：新内核 token（含新通用信封）必须先改 owning 件文档（见 DESIGN §3.4 索引）再落码（方案与代码同变）。

## 7. 决策记录（Context 层）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| C1 | 一切事件皆 token（模式编码在 token、泛型即载荷）；**不用 declaration merging** | 全局 Events 接口合并（dsh/my-agent 手法） | 注册即类型、无中央词表文件、无全局类型污染（修订 DESIGN D10/D14） |
| C2 | 监听器并集 root→leaf 不遮蔽；注册表/服务 nearest-first 遮蔽 | 全遮蔽/全并集 | 多播不遮蔽、单播才遮蔽——spawn 继承与 shadow 的基础 |
| C3 | emit 定向 = chain-up（祖先可见、兄弟不可见） | 全局广播 / 仅本层 | 宿主在 root 听见一切；agent 间隔离 |
| C4 | 高频事件冻结豁免进词表标注 | 全深冻结 | chunk 深冻结成本不可接受；豁免处生产者约定不可变 |
| C5 | 错误 sink 注入而非 logger 服务 | logger 服务 | 自举序：总线工作时服务可能未注册 |
| C6 | waterfall final 由域 owner dispatch 时传入 | final 固化在 token | final 是真实动作（放行/组装/执行），归拥有该动作的件 |
| C7 | guard 坏守卫按弃权计 | 坏守卫中断链 | 一个坏插件不得瘫痪否决链；deny 语义单调 |
| C8 | apply 无 config 参数，配置走工厂闭包 | apply(ctx, config) 通道 | D13/D16 结论：无 settings 通道，单一路径 |
| C9 | **词表单级制**：总线只携带内核 token；插件观察走 `plugin/event` 信封、持久走会话 `plugin/record` 记录槽（SESSION.md）、跨插件类型契约走服务、被拦截经私有 waterfall 实例 | 每插件自铸 token 的自由域（dsh SessionEventMap 合并式开放）；两级制（通用+自由域并存） | 词表 = 规范 = 有限可学；UI 订阅一次渲染一切（L0 对齐）；前缀执法机制整个删除；代价：信封 `data` 为 unknown，由「跨插件契约走服务」补偿 |
| C10 | 插件拦截点 = `ctx.createChain(final)` 匿名链 + 消费方 `ctx.onChain(chain, mw)`：无全局名不进词表，注册层归属消费方（I1 闭合） | 纯工具 `createWaterfallChain`（否决：on() 不进任何账本，注册方 dispose 后中间件残留）；插件在总线自铸 waterfall token | 组合能力保留、词表不增长；final 铸造时绑定（与内核 token 的 dispatch 时传入并存：共享词表 final 归派发方，私有链整体归 owner） |
| C11 | **内核件以插件形态上线**：B–F 件用同一 Plugin 接口（inject topo 保证次序），Context 面只有服务/事件两种注册面，各件的注册能力（工具/命令等）经其服务暴露 | createContext 内置内核件（特权代码）；Context 长出六注册面（my-agent 形态） | everything-is-a-plugin 对内核自身成立；「换驱动」= 不装 loopPiece 装 myLoop()；Context 表面积最小 |
| C12 | **观察面成对律**：UI 的 start/end 观察需求由总线 emit 成对满足（新增 `tool/start`）；观察者绝不用 waterfall 中间件（关键路径，其 bug 打断执行） | 往会话塞 start 事件（与 D20 最小集冲突）；UI 挂拦截链「顺便」观察 | 会话最小化只约束持久事实（重建者消费），观察面按实时渲染者需要立 emit token；两种消费者两种词表 |
| C13 | **通信四模式选择器 + 内核 token 发射权归内核件**：查询→服务、广播→emit、改流程→中间件、重建→会话；插件不得直发内核 token（进度类经 `exec.progress()` 管线代发，审批经 answerer 端口） | 事件当万能通信（查询也走事件）；插件直接 emit 内核词表 | 查询要类型安全（服务是唯一 typed call 面）；发射权集中让审计与词表纪律可执行 |
| C14 | **UI 接收面定稿（11 源）**：session/event、llm/chunk、tool/progress、tool/start+result、approval 对、agent 三 lifecycle、plugin/event——其余全部派生 | UI 认识每个插件的词 | UI 的复杂度 O(1) 于插件数；新插件零 UI 改动即可被渲染 |

## 8. 待讨论与已知限制

- `ScopeFilter` 的具体形状（agentId 键？谓词？）——实现期定
- `llm/chunk` 要不要背压语义（监听器慢时丢帧/缓冲？）——倾向：不背压，慢消费者自排队（emit 同步契约的自然结论）
- **已知限制**：waterfall 监听器永不返回 = 派发挂起——「返回时未调 next → throw」抓不到不返回的；可选超时留实现期裁决，词表设计者对自家 token 自责
- **已知限制**：僵尸 next 的 microtask 极限窗口——中间件 `queueMicrotask(() => next(...))` 后立即 return，微任务回调先于续体执行可绕过「返回后失效」围栏（macrotask 形态已被围栏拦截）；词表设计者自责
- **已知限制**：dispose 不中断在飞 dispatch——快照中间件继续执行，若其依赖的服务已随回卷消失 → `use` throw → dispatch reject（失败暴露不静默）；中断原语（abort 传播）是 loop/llm 的 signal 面
- serial/guard 监听器要不要允许同步返回值（已允许：`Promise<void> | void`）
- `tool/execute` 的 ToolResult 形状（与 tools 契约讨论合并，见 TOOLS.md §7）
- 事件 token 要不要带 `description` 元数据（SPEC 自描述）——倾向要，词表即文档
- inject 是否同时接受服务 token 名（能力耦合）而非仅插件名（名字耦合）——M1 后裁决（见 §10 风险 1）
- **preset-on-scope 等价性验证**（M1 必测）：`loadPlugins` 在 scoped ctx 上跑 + scope 遮蔽是否完整对应 dsh mount.ts + isolate realm 的价值——双 agent 同 preset 各自 apply、服务互不串（见 §10 风险 3）

## 9. 用法预演（装配 → 写插件 → 观察 → 拦截 → 派生 → 回卷 → 一回合全流）

> 本节是 API 的验收剧本：实现期逐段对照，跑不通即为实现或本规格的缺陷。引用的域 token（llmStream、toolExecute 等）定义见各件文档（DESIGN §3.4 索引）。

### 9.0 装配（宿主）

```ts
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPiece, llmPiece, toolsPiece, agentPiece, loopPiece } from "@x-harness/core/pieces";
import { sessionEvent, pluginEvent, agentIdle } from "@x-harness/core/vocab";

const ctx = createContext({
  onListenerError: (err, token) => telemetry.report(err, token.name),
});

await loadPlugins(ctx, [
  sessionPiece(),              // 内核件以插件形态上线（C11）
  llmPiece(),
  toolsPiece(),
  agentPiece(),
  loopPiece(),                 // inject: ["session","llm","tools","agent"]——topo 保证在后
  createPiAdapter({ /* ... */ }),   // 你的适配器插件
  createMyAgent(),                  // 你的 agent 插件
]);
// 换驱动 = 不装 loopPiece，装 myLoop()——一切经同一扇门
```

### 9.1 写插件（开发者；配置走工厂闭包，C8）

```ts
export const notifierService = defineService<{ push(msg: string): void }>("notifier");

export function createNotifier(webhook: string): Plugin {
  return {
    name: "notify",
    inject: [],
    apply(ctx) {
      const queue: string[] = [];
      ctx.provide(notifierService, { push: (m) => queue.push(m) });
      ctx.on(sessionEvent, ({ event }) => {
        if (event.type === "assistant/message") queue.push(summary(event));
      });
      ctx.on(llmChunk, (c) => streamUi.tick(c));          // 高频冻结豁免面
      return () => flush(queue, webhook);                 // disposer 自动入账
    },
  };
}
```

### 9.2 宿主观察一切（root 上订阅，chain-up 保证看见全部后代）

```ts
ctx.on(sessionEvent, ({ event }) => ui.render(event));
ctx.on(pluginEvent, ({ plugin, kind, data }) => ui.toast(plugin, kind, data));
ctx.on(agentIdle, ({ agentId }) => pool.maybeReap(agentId));
```

### 9.3 拦截：重试中间件（串行重调，I2）

```ts
export function createLlmRetry(policy: RetryPolicy): Plugin {
  return {
    name: "llm-retry",
    apply(ctx) {
      ctx.on(llmStream, async (input, next) => {
        for (let attempt = 1; ; attempt++) {
          const stream = next(input);                    // 串行重调 = 真实重发
          const outcome = await watchForRetryable(stream); // 内容首块前的 error 终态才可重试
          if (outcome.retryable && attempt < policy.max) { await delay(backoff(attempt)); continue; }
          return outcome.stream;
        }
      });
    },
  };
}
```

### 9.4 派生：spawn 子代理（scope + nearest-first 遮蔽）

```ts
const child = ctx.scope({ agentId: childId });           // 创建自动入父层账本
child.provide(toolsService, restrict(parentTools, { allow: ["search"] })); // 子层遮蔽
const created = await ctx.use(agentsService).create({ ctx: child, options, setup });
// child.dispose() 只回卷子层：restricted 视图、子层监听、setup 注册的一切
```

### 9.5 被拦截：匿名链扩展点

```ts
// owner：子代理插件暴露 spawn 决策点
const spawnDecide = ctx.createChain<SpawnSpec, Decision>((spec) => defaultDecide(spec));
ctx.provide(agentsService, { spawnDecide });

// 消费方：另一个插件——经自己的 ctx 注册，层归属消费方
ctx.onChain(spawnDecide, async (spec, next) => {
  const d = await next(spec);
  return d.kind === "abstain" ? policy(spec) : d;
});
```

### 9.6 回卷

```ts
await child.dispose();   // 子层串行逆序回卷
await ctx.dispose();     // root 层回卷（未显式 dispose 的子层随父层 effect 收编）
```

### 9.7 一回合全流（token 串联——23 词中的动态子集）

```
send(msg)
→ [会话] user/message（带 turnId = turn 起点）──(总线 session/event)→ UI
→ step 1: dispatch(agentPreStep, 提案)        → 放行（预算插件在此否决）
          dispatch(requestCompose, 草案)       → system 经瀑布写入（prompt 纯插件化）
          [会话] request/header（step 起点 + 工具表快照）
          prepareCall → dispatch(llmStream, {call, request})
              ├─ emit(llmChunk) ×N             → UI 流式
              └─ finish → [会话] assistant/message（tool_use 块/usage/拨号方落账）→ session/event
→ tool_use（已含于 assistant 消息）: dispatch(toolPre) → ask
            → emit(approvalAsked) → answerer → emit(approvalDecided)
            → dispatch(toolGuard) → 弃权
            → emit(toolStart)                     → UI 转圈（权限已过、执行前）
            → dispatch(toolExecute) → final 真实执行 → [会话] tool/result（按 toolCallId 关联）
            → dispatch(toolPost) → accept
→ step 2 …（step 边界 = header↔assistant 配对，无独立 step 事件）
→ dispatch(turnStopping, { steer })            → serial 全跑（续航窗口）
→ [会话] turn/end {reason}（终态自述）→ emit(agentIdle) → 宿主
```

### 9.8 复杂插件走查：压缩（改变模型可见历史）与 OTel 审计（纯观察）

**压缩插件**——策略在插件、事实进内核投影原语：

```ts
export function createCompaction(opts: { threshold: number; summaryModel: CallConfig }): Plugin {
  return {
    name: "compaction",
    inject: ["session", "llm"],
    apply(ctx) {
      const sessions = ctx.use(sessionsService);
      const llm = ctx.use(llmService);
      // 1. 触发策略：fold assistant/message 的 usage × resolveModel(contextWindow) 超阈值
      ctx.on(sessionEvent, ({ event }) => maybeTrigger(event, ctx));
      // 2. 摘要 side 调用：经 llm/stream token dispatch（自带 final）→ 自动继承重试
      async function summarize(range) {
        const call = await llm.prepareCall(opts.summaryModel);
        return consume(await ctx.dispatch(llmStream, { call, request: summaryRequest(range) },
          ({ call: c, request: r }) => c.stream(r)));      // ← C6：final 派发时传入
      }
      // 3. 事实落内核投影原语（不是 compaction 专用词——内核不知道"压缩"这个概念）：
      //    sessions.append("history/splice", { fromSeq, toSeq, replacement: summaryMsg })
      //    投影规则（内核唯一拥有）：区间内消息不再可见，replacement 内联出现在原位置；
      //    世代 = splice 计数（折叠派生）；单事件原子追加，无半压缩态。
    },
  };
}
```

**OTel 审计插件**——零新增内核面，全部消费现成 token：

```ts
export function createOtel(opts: { endpoint: string; sample: Sampler }): Plugin {
  return {
    name: "otel",
    apply(ctx) {
      const tracer = makeTracer(opts);
      ctx.on(sessionEvent, ({ event }) => tracer.fact(event));       // turn/step span（ts+seq+归属键）
      ctx.on(llmStream, async (input, next) => {                     // llm span 精确起止
        const span = tracer.start(input.request);
        try { return await next(input); } finally { span.endOnDrain(); }
      });
      ctx.on(toolExecute, async (exec, next) => {                    // 工具 span
        const span = tracer.startTool(exec);
        try { return await next(exec); } finally { span.end(); }
      });
      ctx.on(approvalAsked, (a) => tracer.audit(a));
      ctx.on(approvalDecided, (d) => tracer.audit(d));
      ctx.on(agentIdle, ({ agentId }) => tracer.markIdle(agentId));
      return () => tracer.shutdown();
    },
  };
}
```

## 10. 与 dsh 内核逐维对照（逻辑合理性验证）

> 对照 Cordis 机制逐维检验本设计。结论：语义同构或更严格，无结构性缺陷；三个等价性风险在实现期验证（已挂 §8）。

| 维度 | dsh（Cordis） | x-harness | 裁决 |
|---|---|---|---|
| 插件形态 | 函数插件 + Service 子类两种；config 走 schemastery 通道 | 单一 `Plugin{name, inject, apply}`；config 工厂闭包（C8） | 更简；config 通道差异属产品议题（DESIGN §8） |
| 依赖注入 | inject = 服务键，可用性驱动（反应式） | inject = 插件名 topo + use fail-fast + `service/provided` 监听 | 等价（服务由件提供）；反应式以监听覆盖 |
| 派发模式 | 五种：emit/waterfall/parallel/serial/bail | 四种：emit/waterfall/serial/guard | bail ≈ waterfall 特例；parallel 不预写（shutdown 由 effect 回卷覆盖，「并发等待」场景出现再加）；guard 一级化（dsh 藏在 tools 包） |
| waterfall 纪律 | 必须 next（retry 依赖重调） | 至少一次 + 串行重调合法 + 并发 throw + final 可重执行性词表标注 | 对齐且纪律成文 |
| 词表 | declaration merging 开放（坑 P1） | token 注册即类型 + 单级 23 词 + 信封/记录槽 | 核心分叉，L0 动机（C9） |
| 插件扩展点 | 自铸事件词条 | `ctx.createChain` 匿名链 + `onChain` | 组合能力保留、词表零增长（C10） |
| scope | ScopedLayers shadow + scopeTarget + isolate realm | 层链过滤视图（监听并集/注册表遮蔽/chain-up/scope 入父账本） | 语义同构且成文；isolate 等价性 = 风险 3 |
| 生命周期 | 注册即 effect、卸载回卷、HMR | effect 账本串行逆序、unwind 边界、无 HMR（坑 P4） | 更严格 |
| setup 事务 | setupAndPublish + commit | setup 窗口失败整体回滚（scope dispose） | 一致 |
| 错误处理 | emit 包容 | sink 注入 + per-mode 语义矩阵 | 更明确 |
| 冻结 | 请求 deep-freeze | 词表标注 deep/none + 高频豁免 | 更系统 |

**实现期验证的等价性风险：**

1. inject 耦合插件名（谁）而非服务键（能力）——当前等价；插件可替换提供同能力时僵化，改进选项 = inject 兼收 token 名（M1 后裁决）。
2. parallel 缺位是「被推迟」不是「被证明不需要」——并发等待场景真出现时保持加第五种模式的口子。
3. preset-on-scope（最重要）：dsh 用 mount.ts + isolate realm 防止 preset 内服务行变成进程全局、两会话冲突；我们的对应物 = `loadPlugins` 在 scoped ctx 上跑 + scope 遮蔽。M1 必测：双 agent 同 preset 各自 apply、服务互不串。
