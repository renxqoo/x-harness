# 通用插件内核使用指南

core 提供进程内的插件宿主。应用定义自己的服务、处理链、决策关口和通知事件，插件通过这些契约协作。Agent、会话、消息上下文、模型、工具、skill、压缩、权限规则和房间都由外部插件实现。

本文的 TypeScript 片段共用前文的类型和函数，全部针对真实公开入口进行类型检查。快速开始是完整的创建、装配、调用和关闭流程，其余片段可以按需要组合。

## 1. 接入包

公开入口为 `@x-harness/core`。本地应用应把依赖明确指向本目录，例如应用的 package.json：

```json
{
  "dependencies": {
    "@x-harness/core": "file:/Users/wrr/work/x-harness/packages/v2/core"
  }
}
```

在该应用目录安装依赖后，从包入口导入。不要从内部模块路径导入，也不要重新创建一份同名 token。

包的 exports 当前指向 TypeScript 源码，需要 Bun 或能够处理 TypeScript 的构建工具。`packages/v2` 中的构建命令生成 `core/dist/index.js`，运行实现使用标准 Promise、AbortSignal 和计时器，没有 node/bun 平台 I/O 依赖。本目录没有发布 npm 包的流程。

## 2. 快速开始

下面定义一个服务，装配它的提供插件，调用服务，然后等待整个宿主关闭。`runQuickStart("小明")` 成功时返回 `{ ok: true, value: "你好，小明" }`。

```ts
import { createContext, defineService } from "@x-harness/core";
import type { Plugin, Result } from "@x-harness/core";

interface GreetingService {
  greet(input: { name: string }): Promise<Result<string>>;
}

export async function runQuickStart(name: string): Promise<Result<string>> {
  const contract = defineService<GreetingService>({
    name: "example/greeting",
    methods: { greet: {} },
  });
  if (!contract.ok) return contract;
  const greeting = contract.value;

  const provider: Plugin = {
    name: "greeting-provider",
    provides: [greeting],
    apply(ctx) {
      return ctx.provide(greeting, {
        async greet(input) {
          return { ok: true, value: `你好，${input.name}` };
        },
      });
    },
  };

  const created = createContext();
  if (!created.ok) return created;
  const root = created.value;
  const loaded = await root.load([provider]);
  if (!loaded.ok) {
    const closed = await root.dispose();
    return closed.ok ? loaded : closed;
  }

  const service = root.use(greeting);
  const result = service.ok
    ? await service.value.greet({ name })
    : service;
  const closed = await root.dispose();
  return closed.ok ? result : closed;
}
```

真实应用通常在启动时创建 root，在运行期间保留它，在应用退出时 `await root.dispose()`。只调用 requestClose 表示发起停止，不能代替等待清理结果。

## 3. 选择扩展机制

| 机制 | 定义 | 提供 / 接入 | 执行 | 适用场景 |
| --- | --- | --- | --- | --- |
| 服务 | defineService | provide / use | 调用服务方法 | 状态读写、上下文修改、工具执行、实例管理 |
| 调用链 | defineChain | provide / on | dispatch | 请求变换、短路、顺序重试 |
| 决策关口 | defineGuard | provide / on | dispatch | 应用显式调用的授权或策略判断 |
| 通知事件 | defineEvent | provide / on | emit | 有界异步通知、观察和唤醒 |
| 作用域 | ctx.scope | root.load 的 scope 参数 | root.closeScope | 隔离插件实例和资源生命周期 |
| 任务 | ctx.spawn / call.spawn | run | root.wait / call.wait | 后台工作或结构化子任务 |
| 资源 | ctx.effect / call.effect | disposer | 关闭时清理 | 连接、订阅、临时上下文登记 |

普通插件优先通过服务表达意图。例如插入系统提示词就是调用外部上下文服务；需要改变某条执行过程时才接入 chain。

下文使用的额外公开类型：

```ts
import type {
  ChainToken,
  Context,
  Disposer,
  EventToken,
  GuardToken,
  Invocation,
  LoadReport,
  PluginRef,
  RootContext,
  ServiceToken,
  TaskHandle,
} from "@x-harness/core";
```

## 4. 定义契约与处理结果

契约定义应放在应用的公共契约模块。装配时处理工厂的 Result，并把成功的 token 传给插件工厂。消费者和提供者必须持有同一个 token 对象；名称相同不代表同一个契约。

服务接口只包含方法，每个方法接收一个参数并返回 `Promise<Result<T, E>>`。无输入方法使用 `input: void`，调用时传 undefined；不使用同步返回、多参数、可选参数、rest、泛型方法或重载。

成功和失败分别读取 value 和 reason：

```ts
type RequestFailure = { kind: "rejected"; message: string };

function describeRequest(result: Result<string, RequestFailure>): string {
  if (result.ok) return result.value;
  if ("source" in result.reason && result.reason.source === "core") {
    return result.reason.code;
  }
  if ("kind" in result.reason) return result.reason.message;
  return result.reason.message;
}
```

`source: "core"` 是内核保留的错误判别。业务错误可以使用自己的 code，包括 timeout，但不能占用该来源字段。回调抛错会变成 callback-failed；非法返回形态变成 invalid-result。

服务可以为 input、output 和业务 failure 配置校验器。未配置时，进程内值按声明的业务契约传递，不进行隐式 JSON 转换或深拷贝。chain、guard 和 event 必须提供校验器。下面是共享字符串校验器：

```ts
function parseText(input: unknown): Result<string> {
  if (typeof input === "string") return { ok: true, value: input };
  return {
    ok: false,
    reason: { source: "core", code: "invalid-input", message: "Expected a string" },
  };
}
```

定义名称由小写字母、数字、连字符和斜杠组成，例如 example/request；以字母开头，最长 160 字符。定义的 core/ 前缀保留给内核。完整错误词表与签名见 [API](../API.md)。

## 5. 编写普通插件

| 字段 | 含义 |
| --- | --- |
| name | 同一装配作用域内唯一的插件名称 |
| provides | apply 必须实际提供的服务或扩展点 |
| requires | 激活前必须存在的依赖 |
| optional | 可以缺席的依赖；缺席也是固定装配结果 |
| apply(ctx, call) | 登记能力和资源，返回 Result<void> 或 Result<Disposer> |

load 按依赖顺序激活整个批次，全部成功后才发布。缺少依赖、循环依赖、声明的提供项未实现或激活失败都会拒绝安装。失败批次回滚受管登记与资源；任意外部写入的补偿由插件自己负责。

依赖在装配时绑定固定实例。在线安装新的提供者不会自动补上先前缺席的 optional，也不会把现有消费者重定向到另一代服务。重新装配需要宿主明确卸载并安装相关插件。

### 系统提示词、skill 列表与纠正消息

上下文协议属于外部领域。下面的插件只依赖该协议，内核不需要识别消息角色或 skill。

```ts
interface ContextMaterial {
  key: string;
  role: "system" | "user";
  content: string;
}

interface ConversationService {
  register(input: ContextMaterial): Promise<Result<Disposer>>;
  append(input: { role: "user"; content: string }): Promise<Result<void>>;
}

function createSystemPromptPlugin(
  conversation: ServiceToken<ConversationService>,
  prompt: string,
): Plugin {
  return {
    name: "system-prompt",
    requires: [conversation],
    apply(ctx) {
      const service = ctx.use(conversation);
      if (!service.ok) return service;
      return service.value.register({
        key: "instruction",
        role: "system",
        content: prompt,
      });
    },
  };
}

function createSkillListPlugin(
  conversation: ServiceToken<ConversationService>,
  loadList: (call: Invocation) => Promise<Result<string>>,
): Plugin {
  return {
    name: "skill-list",
    requires: [conversation],
    async apply(ctx, call) {
      const service = ctx.use(conversation);
      if (!service.ok) return service;
      const list = await loadList(call);
      if (!list.ok) return list;
      return service.value.register({
        key: "available-skills",
        role: "user",
        content: list.value,
      });
    },
  };
}
```

register 返回的 disposer 表示撤销登记，apply 可以直接返回它。提供者应使用 call.effect 把这份登记归到消费方生命周期。扫描、过滤、渲染和目录更新属于 skill 插件；对话材料的写入与投影属于对话插件。

纠正消息在运行时通过绑定的依赖门面写入：

```ts
async function appendCorrection(
  ctx: Context,
  call: Invocation,
  conversation: ServiceToken<ConversationService>,
  content: string,
): Promise<Result<void>> {
  const bound = call.bind(ctx);
  if (!bound.ok) return bound;
  const service = bound.value.use(conversation);
  if (!service.ok) return service;
  return service.value.append({ role: "user", content });
}
```

这里的 user 是模型消息角色。真实调用来源来自 core 的 Invocation.origin，不能用角色字段冒充实际用户。压缩同样通过外部对话服务修改上下文，其并发条件、消息边界、日志和恢复协议由该领域定义。

## 6. 嵌套调用与 Invocation

消费者调用服务时不传 Invocation；提供者实现的第二个参数由 core 生成。它包含本次调用身份、父调用身份、来源、执行者、资源拥有者、signal、deadline 和执行阶段。

在服务方法、chain、guard、observer 或 task 内调用其他依赖时，用 `call.bind(ctx)`。绑定后的 use/dispatch 继承父调用、取消和截止时间。单纯闭包捕获 ctx 再 use，不会自动推断异步父调用。

apply 中的静态登记可以直接 ctx.use。明确的后台任务使用 ctx.spawn，不通过未绑定的服务调用隐式制造后台工作。不要保存绑定的服务门面供未来调用；其所属调用结束后门面失效。

## 7. 调用链：变换与顺序重试

```ts
import { defineChain, defineEvent, defineGuard } from "@x-harness/core";

function defineRequestChain() {
  return defineChain<string, string, RequestFailure>({
    name: "example/request",
    input: parseText,
    output: parseText,
  });
}

function createRequestProvider(chain: ChainToken<string, string, RequestFailure>): Plugin {
  return {
    name: "request-provider",
    provides: [chain],
    apply(ctx) {
      return ctx.provide(chain, async (input) => ({ ok: true, value: input.trim() }));
    },
  };
}

function createRetryPlugin(chain: ChainToken<string, string, RequestFailure>): Plugin {
  return {
    name: "request-retry",
    requires: [chain],
    apply(ctx) {
      return ctx.on(chain, async (input, next, call) => {
        const first = await next(input);
        if (first.ok || call.signal.aborted) return first;
        if (!("kind" in first.reason) || first.reason.kind !== "rejected") return first;
        return await next(input);
      });
    },
  };
}

async function dispatchRequest(root: RootContext, chain: ChainToken<string, string, RequestFailure>) {
  return root.dispatch(chain, " request ", { timeoutMs: 2000 });
}
```

provide 登记终结处理器，on 登记中间件。处理器按作用域和装配顺序执行，可以修改输入、返回 next 或直接短路返回 Result。不要依赖调用方安装数组的书写顺序替代依赖顺序。

next 必须等待或直接返回，顺序重试合法，并发调用返回 concurrent-next。处理器返回后再调用 next 返回 late-next；未结算 next 或派生 Continuation 返回 unfinished-next，未观察失败返回 unobserved-next。then/catch/finally 的派生链也参与检查，底层未结束时不会释放实际工作记录。

重试条件、退避和外部副作用去重由业务插件定义；示例只是接入写法，不代表所有 rejected 都适合重试。实际授权应该处在每次重试都会经过的执行路径中。

## 8. 决策关口：明确允许或拒绝

```ts
function defineAccessGuard() {
  return defineGuard({ name: "example/access", input: parseText });
}

function createAccessProvider(gate: GuardToken<string>): Plugin {
  return {
    name: "access-provider",
    provides: [gate],
    apply(ctx) {
      return ctx.provide(gate);
    },
  };
}

function createAccessPolicy(gate: GuardToken<string>): Plugin {
  return {
    name: "access-policy",
    requires: [gate],
    apply(ctx) {
      return ctx.on(gate, (input) => ({
        ok: true,
        value: input === "allowed"
          ? { kind: "allow" }
          : { kind: "deny", reason: "Access denied" },
      }));
    },
  };
}

async function executeAllowed(
  ctx: Context,
  call: Invocation,
  gate: GuardToken<string>,
  input: string,
): Promise<Result<string, RequestFailure>> {
  const bound = call.bind(ctx);
  if (!bound.ok) return bound;
  const decision = await bound.value.dispatch(gate, input);
  if (!decision.ok) return decision;
  if (decision.value.kind === "deny") {
    return { ok: false, reason: { kind: "rejected", message: decision.value.reason } };
  }
  return { ok: true, value: input };
}
```

无处理器返回 guard-unconfigured；所有处理器明确 allow 才允许，首次 deny 停止后续处理器。异常、取消、超时和非法返回都是失败。应用的执行服务必须主动调用 guard 并阻断失败；core 不会自动知道哪条业务路径需要授权。

## 9. 通知事件：订阅与发送

```ts
function defineChangedEvent() {
  return defineEvent({ name: "example/changed", payload: parseText });
}

function createChangedPublisher(changed: EventToken<string>): Plugin {
  return {
    name: "changed-publisher",
    provides: [changed],
    apply(ctx) {
      return ctx.provide(changed);
    },
  };
}

function createChangedObserver(
  changed: EventToken<string>,
  receive: (payload: string, call: Invocation) => Promise<void>,
): Plugin {
  return {
    name: "changed-observer",
    requires: [changed],
    apply(ctx) {
      return ctx.on(changed, (payload, _origin, call) => receive(payload, call));
    },
  };
}

function notifyChanged(root: RootContext, changed: EventToken<string>) {
  return root.emit(changed, "updated");
}
```

emit 成功仅表示接受了通知，回执 acceptedListeners 是接受的监听者数，不表示它们已经处理成功。同一监听者 FIFO、最多一个实际在途处理；不同监听者独立运行。监听超时会暂停该监听者并撤销其待执行队列，其他监听者继续运行。

事件载荷必须是有界 JSON 数据；发送时制作不可变快照，拒绝访问器、循环、非法原型、非有限数字和超限数据。origin 由 core 填充，sequence 仅表示本宿主的通知接受顺序。

插件只有事件提供者可以直接 emit 自己的事件；订阅插件声明 requires/optional 后 on。需要允许消费者提交消息时，由提供者公开受控服务。宿主可以 emit 可见事件。事件不提供持久化、确认、重放或可靠投递协议。

## 10. 作用域与宿主控制

```ts
async function installIsolated(
  root: RootContext,
  plugins: readonly Plugin[],
): Promise<Result<Context>> {
  const child = root.scope({ label: "isolated-instance" });
  if (!child.ok) return child;
  const loaded = await root.load(plugins, { scope: child.value });
  if (!loaded.ok) {
    const closed = await root.closeScope(child.value);
    return closed.ok ? loaded : closed;
  }
  return child;
}
```

作用域控制可见能力和生命周期；可继承祖先能力，不访问兄弟作用域的私有登记。默认不允许覆盖祖先服务；明确需要遮蔽时，提供者使用 `ctx.provide(token, implementation, { shadow: true })`。作用域预算只能收紧，不能通过增加子作用域绕过根宿主总量限制。

多 Agent 可以使用独立作用域装配独立领域插件，再由外部房间服务协调。core 不判断 Agent 角色、成员、发言轮次或消息路由。

ctx.state 描述作用域状态；插件实例是否 active/stopping 应通过宿主 inspect 查看。

root.load/unload/closeScope/dispose/wait 是宿主接口，不交给普通插件。插件只能创建自己的子作用域，或 requestClose 请求自身停止；宿主负责等待最终关闭。需要动态创建实例时，应用公开受控实例管理服务，由宿主实施装配，避免插件获得整个 RootContext。

## 11. 任务、取消与超时

```ts
function startStructuredTask(ctx: Context): Result<TaskHandle<number>> {
  return ctx.spawn<number>({
    label: "parent-task",
    timeoutMs: 2000,
    async run(call) {
      const child = call.spawn<number>({
        label: "child-task",
        run: () => ({ ok: true, value: 21 }),
      });
      if (!child.ok) return child;
      const result = await call.wait(child.value);
      if (!result.ok) return result;
      return { ok: true, value: result.value * 2 };
    },
  });
}

async function waitForTask(root: RootContext, task: TaskHandle<number>) {
  return root.wait(task, { timeoutMs: 1000 });
}
```

ctx.spawn 创建拥有者级任务；call.spawn 创建本次调用的结构化子任务。父调用会连接等待其未显式等待的子任务，未处理的子任务失败影响父调用。等待环返回 wait-cycle。

wait 超时只结束本次等待，不取消目标。需要取消时调用 task.cancel，或为任务配置 signal。任务或调用超时后公开返回失败，底层工作仍被追踪，TaskHandle.state 在实际结束前保持 running，迟到成功不会覆盖第一次 timeout/cancelled。

服务方法没有额外的调用选项参数；通过父调用的 bind 继承取消和期限。需要在宿主为一段服务工作设置独立预算，可以在带 signal/timeoutMs 的 root.spawn 任务中执行，并用 call.bind(root) 取得依赖门面。chain/guard 的 dispatch 可直接传 CallOptions。

外部 I/O 应接收 call.signal 并及时结束。core 不会强制终止 JavaScript 同步循环；进程终止与执行隔离属于外部宿主。

## 12. 资源登记与清理

ctx.provide、ctx.on 和 ctx.effect 的成功值都是受管 disposer；登记自动归当前拥有者，不需要再收集一遍 off 列表。同一拥有者重复登记同一个 disposer 不重复释放；跨拥有者复用同一个函数会被拒绝。

| 登记方式 | 生命周期拥有者 | 清理执行者 |
| --- | --- | --- |
| ctx.effect | 当前插件或作用域拥有者 | 当前拥有者 |
| call.effect | 本次调用的 resourceOwner | 当前 executor |

服务为消费者创建连接或上下文材料时，使用 call.effect，使消费者卸载时资源随之释放。清理闭包应在分配外部资源之前登记，并保存随后取得的句柄。

```ts
interface ResourceHandle {
  id: string;
}

interface ResourceService {
  open(input: void): Promise<Result<Disposer>>;
}

function createResourceProvider(
  token: ServiceToken<ResourceService>,
  adapter: {
    open(signal: AbortSignal): Promise<Result<ResourceHandle>>;
    close(handle: ResourceHandle, signal: AbortSignal): Promise<Result<void>>;
  },
): Plugin {
  return {
    name: "resource-provider",
    provides: [token],
    apply(ctx) {
      return ctx.provide(token, {
        async open(_input, call) {
          let handle: ResourceHandle | undefined;
          const owned = call.effect(async (cleanup) => {
            if (!handle) return { ok: true, value: undefined };
            return adapter.close(handle, cleanup.signal);
          });
          if (!owned.ok) return owned;
          const opened = await adapter.open(call.signal);
          if (!opened.ok) {
            const released = await owned.value({
              context: ctx,
              signal: call.signal,
              deadline: call.deadline,
            });
            return released.ok ? opened : released;
          }
          handle = opened.value;
          return owned;
        },
      });
    },
  };
}
```

先登记再分配，才能确保取消后迟到创建的句柄仍归资源账本。内核先等待实际创建工作结束，再执行清理，不会因为一开始句柄为空就提前删除清理记录。

清理回调收到内核提供的 cleanup.context、signal 和 deadline。cleanup.context 只能使用固定清理依赖，不允许创建新的插件、资源或后台任务；它能在提供者 stopping 时调用尚未最终释放的服务。需要调用依赖清理时，重新从 cleanup.context.use 获取门面，不使用已取消的业务门面。

受管 disposer 手动调用时，参数不会替换内核生成的清理上下文和预算。提供者仍被依赖或存在在途工作时，手动撤销返回 plugin-in-use。一般由宿主 unload/closeScope/dispose 完成有序清理；apply 可直接返回 ctx.provide/on/effect 或服务返回的受管 disposer。

## 13. 在线装配与卸载

```ts
function installExtension(root: RootContext, plugin: Plugin): Promise<Result<LoadReport>> {
  return root.load([plugin]);
}

async function removeExtension(root: RootContext, ref: PluginRef): Promise<Result<void>> {
  const removed = await root.unload(ref);
  if (!removed.ok) return removed;
  return { ok: true, value: undefined };
}
```

PluginRef 从 load.value.plugins 或 inspect().plugins 中取得，保留原对象；不要根据名称拼装、复制或从另一个宿主传入引用。

默认 unload 拒绝仍有固定消费者的提供者。宿主明确传 `{ cascade: true }` 时，会连同相关消费者及其拥有的子作用域一起按依赖关闭。真正的外部宿主依赖仍可能阻断卸载。级联意味着相关插件一起停止，不是服务热替换。

在线安装的处理器只影响后续捕获的执行计划；已进入的调用继续执行其原计划。若计划中的处理器尚未进入就被撤销，该调用返回 extension-revoked。根宿主统一串行化装配和卸载，关闭信号可以打断正在激活的插件。apply 或清理回调不要等待新的装配；由宿主在当前操作完成后处理实例创建需求，避免等待自己所占用的装配队列。

npm 下载、依赖解析、模块导入、配置许可与包的执行隔离由外部应用实现。core.load 接收已经取得的 Plugin 对象；core 不接收 npm 包名，也不执行 package manager。已加载到同一 JavaScript 进程的第三方插件不是安全沙箱。

## 14. 配置、诊断与关闭失败

```ts
function createConfiguredHost() {
  return createContext({
    limits: {
      maxPlugins: 256,
      maxActiveCalls: 512,
      maxActiveTasks: 128,
      maxPendingEvents: 256,
      callTimeoutMs: 15000,
      activationTimeoutMs: 5000,
      closeTimeoutMs: 10000,
    },
  });
}
```

数量与时间使用正安全整数，单位为毫秒；非法配置返回 invalid-input。完整默认值见 [限制与时间](../API.md#9-限制与时间)。测试可注入单调 Scheduler；生产配置应保持 now 单调且计时器可撤销。

inspect 返回只读快照，包含插件状态、调用、任务、事件排队、服务门面、资源及剩余工作身份。diagnostics 返回有界诊断；可在 createContext 的 onDiagnostic 中接入外部日志。日志接入自身出错不会让诊断递归。

dispose/closeScope 的并发或重复调用共用关闭操作，不重新延长预算。关闭会停止新准入，取消工作，等待实际结算，先释放消费方资源，再释放提供者能力。

| 结果 | 宿主应如何处理 |
| --- | --- |
| 成功回执 | 对应生命周期已完成清理 |
| close-incomplete | 截止时间到达或仍有未收敛工作；检查剩余身份，不假装成功 |
| activation-unsettled | 失败装配未完成回滚；宿主 degraded，拒绝继续装配 |
| close-failed 状态 | 清理失败或尚未完成，检查诊断与资源账本 |

关闭截止时间到达时可以先返回失败；底层工作随后真正结束，inspect 可能最终变成 closed，先前失败回执不会改写。清理失败仍会继续处理其他资源，没有隐式重试或强制删除账本。

## 15. 验证与更多文档

在 `/Users/wrr/work/x-harness/packages/v2` 执行：

```sh
bun run typecheck
bun run lint
bun run build
bun run test
```

typecheck 验证源码、类型负例和文档示例；test 在 Bun 下运行内核用例并输出覆盖率诊断。测试位于 core/src/**/__test__/，按行为、异常、边界和故障回归验收。

- [完整接口与错误语义](../API.md)
- [架构边界](../ARCHITECTURE.md)
- [外部插件组合示例](../EXAMPLES.md)
- [测试组织与异常矩阵](src/__test__/README.md)
- [当前验收记录](../VERIFICATION.md)
