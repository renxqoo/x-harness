# 通用插件内核

core 为应用提供插件装配、能力协作、受管执行和资源生命周期。普通服务端、AI 应用或其他程序使用同一套机制；内核不包含 HTTP、数据库、模型或其他领域实现。

## 常用接口

| 用途 | 接口 |
| --- | --- |
| 提供服务 | ctx.service |
| 提供处理链终结函数 | ctx.handle |
| 使用服务依赖 | setup 内使用 ctx.deps，处理函数内使用 call.deps |
| 监听事件、发出事件 | ctx.on、ctx.emit |
| 登记中间件、决策处理器 | ctx.middleware、ctx.guard |
| 执行处理链或关口 | call.dispatch；初始化时可用 ctx.dispatch |
| 创建与关闭资源 | ctx.resource({ open, close })；消费方资源使用 call.resource |
| 登记清理动作 | ctx.addCleanup；调用上下文保留 call.effect |
| 启动任务 | ctx.startTask；结构化子任务使用 call.spawn |
| 创建范围 | ctx.createScope |
| 查看所在范围 | ctx.scopeId、ctx.scopeState |
| 宿主管理 | createHost、app.install、app.uninstall、app.close |
| 宿主取得服务 | app.use(token) |

## 第一个插件

用服务契约定义方法，用插件交付实现。服务 token 必须共享，不要复制同名 token。

```ts
import { createHost, definePlugin, defineService } from "@x-harness/core";
import type { ChainToken, CleanupInvocation, Context, EventToken, GuardToken, Invocation, Plugin, PluginContext, PluginImplementations, Result, Host, ServiceToken } from "@x-harness/core";

type Greeting = { greet(input: { name: string }): Promise<Result<string>> };
const greetingContract = defineService<Greeting>({ name: "greeting", methods: { greet: {} } });
```

插件声明 `provides`，并在 `setup` 中提供实现。`input` 自动推断，登记自动归插件。宿主负责安装、使用和关闭。

```ts
async function greetingApplication(): Promise<Result<string>> {
  if (!greetingContract.ok) return greetingContract;
  const greeting = greetingContract.value;
  const created = createHost();
  if (!created.ok) return created;
  const app = created.value;
  try {
    const installed = await app.install([definePlugin({
      name: "greeting",
      provides: { greeting },
      setup(ctx) {
        return ctx.service({ greeting: {
          async greet(input) { return { ok: true, value: `你好，${input.name}` }; },
        } });
      },
    })]);
    if (!installed.ok) return installed;
    const service = app.use(greeting);
    if (!service.ok) return service;
    return service.value.greet({ name: "小明" });
  } finally {
    const closed = await app.close();
    if (!closed.ok) return closed;
  }
}
```

`definePlugin` 创建不可变声明，不安装插件。`setup` 返回 Result；成功值不解释为清理回调。需要清理的资源显式使用 resource 或 effect。安装失败回滚整批，成功后一次发布。

## 声明与调用依赖

requires 是必需依赖，optional 是可选依赖，provides 是输出能力。三者都是本地名称到共享 token 的映射。名称不能跨组冲突，同一 token 只声明一次。服务、处理链、关口和事件使用同一声明协议。

```ts
type User = { id: string; name: string };
type UserStore = { findUser(input: { id: string }): Promise<Result<User | null>> };
type Users = { find(input: { id: string }): Promise<Result<User | null>> };
declare const userStore: ServiceToken<UserStore>;
declare const users: ServiceToken<Users>;

const usersPlugin = definePlugin({
  name: "users",
  requires: { userStore },
  provides: { users },
  setup(ctx) {
    return ctx.service({ users: {
      async find(input, call) { return call.deps.userStore.findUser(input); },
    } });
  },
});
```

ctx.deps 用于初始化，激活结束后失效。方法、处理器、任务和资源取得函数使用 call.deps；它只包含该插件声明的服务依赖，自动继承父调用、取消、期限和逻辑消费方。不要捕获初始化门面供后续请求使用。

可选依赖缺席时为 undefined。装配结果固定，之后安装提供者不会自动补齐；已绑定门面也不会重定向。

依赖表具有完整、可枚举的声明名称，表和服务门面均冻结。多服务表的每个槽位在首次读取时创建并缓存门面，单服务表直接创建唯一门面；调用方法时才取得服务租约。Object.keys 仅枚举名称，Object.values、展开和解构会读取对应的值。取得租约失败不会缓存该失败，容量释放后可重试。多服务槽位是只读 getter，反射代码应通过属性读取取得值。

```ts
const optionalUsers = definePlugin({
  name: "optional-users",
  optional: { userStore },
  provides: { users },
  setup(ctx) {
    return ctx.service({ users: {
      async find(input, call) {
        if (!call.deps.userStore) return { ok: true, value: null };
        return call.deps.userStore.findUser(input);
      },
    } });
  },
});
```

## 抽出实现函数

保存一份声明，使用 typeof 声明推导作者类型。独立函数和内联 setup 使用相同权限，不需要重新填写依赖和提供者列表。

```ts
const usersManifest = { name: "extracted-users", requires: { userStore }, provides: { users } };
const usersImplementation: PluginImplementations<typeof usersManifest> = {
  users: { async find(input, call) { return call.deps.userStore.findUser(input); } },
};

function setupUsers(ctx: PluginContext<typeof usersManifest>) {
  return ctx.service(usersImplementation);
}

const extractedUsersPlugin = definePlugin({ ...usersManifest, setup: setupUsers });
```

PluginInvocation 使用相同的 typeof 声明；PluginResource 和 PluginTask 的参数为结果值、业务错误、声明。optional 仍需判空。仅保存与业务无关的实现工厂或无状态函数；连接、缓存和可变状态在 setup 内为每次安装创建。

声明表应是确定存在的对象。表本身可选或可能为 undefined 时，类型不会假定其中有能力；不同分支中同名槽的种类或服务协议不一致时，应先收窄声明再定义插件。可选服务写在确定存在的 optional 表中。

同协议的多个名称可以使用联合变量调用，参数和结果保持精确；不同协议的名称变量需先分支判断，再调用对应名称。

## 配置

配置属于插件工厂。业务工厂先校验输入，再创建插件；内核不内置配置 schema 或业务默认值。

```ts
function createGreetingPlugin(prefix: unknown): Result<Plugin> {
  if (typeof prefix !== "string" || !greetingContract.ok) return { ok: false, error: { source: "core", code: "invalid-input", message: "invalid-input" } };
  const greeting = greetingContract.value;
  return { ok: true, value: definePlugin({
    name: "configured-greeting", provides: { greeting },
    setup(ctx) {
      return ctx.service({ greeting: {
        async greet(input) { return { ok: true, value: prefix + input.name }; },
      } });
    },
  }) };
}
```

## 资源取得与关闭

resource 在调用 open 前预留容量并登记清理。open 获得本次取得工作的调用上下文；close 获得独立的清理信号和固定清理依赖。

```ts
interface Connection {
  read(input: { id: string }, signal: AbortSignal): Promise<Result<User | null>>;
  close(signal: AbortSignal): Promise<Result<void>>;
}
declare function connect(signal: AbortSignal): Promise<Result<Connection>>;

const databasePlugin = definePlugin({
  name: "database", provides: { userStore },
  async setup(ctx) {
    const acquired = await ctx.resource({
      open: (call) => connect(call.signal),
      close: (connection, cleanup) => connection.close(cleanup.signal),
    });
    if (!acquired.ok) return acquired;
    const connection = acquired.value;
    return ctx.service({ userStore: {
      async findUser(input, call) { return connection.read(input, call.signal); },
    } });
  },
});
```

成功交付的资源随归属者关闭。取消、超时后迟到取得且未交付的资源，在取得工作实际结束后立即回收，不等待活跃归属者退出。取得失败的空登记会移除；内部部分分配却没有交付句柄的补偿由 adapter 负责。清理失败保留账本和必要依赖。

ctx.resource 归插件；call.resource 归逻辑消费方。自动关闭只保证受管工作，无法推断任意裸对象或 JavaScript 闭包的使用关系。普通资源值没有内核提前释放句柄。需要提前关闭时，创建独立子范围，由范围停止准入、排空并清理。

仅需登记清理动作时使用 addCleanup。异步创建资源优先使用 resource，让容量预留、创建和清理由同一操作负责。

```ts
function ownCleanup(app: Context, cleanup: (call: CleanupInvocation) => Promise<Result<void>>) {
  return app.addCleanup(cleanup);
}
```

## 处理链

链提供一个终结者和有序处理中间件。next 返回受跟踪 Continuation，支持 then/catch/finally；同一帧禁止并发 next，处理器不能遗留未完成或未观察的失败。

```ts
declare const transform: ChainToken<string, string>;
const terminalPlugin = definePlugin({
  name: "transform", provides: { transform },
  setup(ctx) { return ctx.handle("transform", (input) => ({ ok: true, value: input })); },
});
const middlewarePlugin = definePlugin({
  name: "uppercase", requires: { transform },
  setup(ctx) { return ctx.middleware("transform", (input, next) => next(input.toUpperCase())); },
});
```

请求中的链和关口使用 call.dispatch，保持本次执行关系。setup 中可以使用 ctx.dispatch 做受管初始化。

```ts
declare const render: ServiceToken<{ run(input: string): Promise<Result<string>> }>;
const renderPlugin = definePlugin({
  name: "render", requires: { transform }, provides: { render },
  setup(ctx) {
    return ctx.service({ render: {
      async run(input, call) { return call.dispatch("transform", input); },
    } });
  },
});
```

## 决策关口

关口由处理器返回 allow 或 deny；拒绝优先，配置为空时返回 guard-unconfigured。规则本身由业务插件定义。

```ts
declare const access: GuardToken<{ userId: string }>;
const accessPlugin = definePlugin({
  name: "access", provides: { access },
  setup(ctx) {
    return ctx.guard("access", (input) => ({ ok: true, value: input.userId
      ? { kind: "allow" } : { kind: "deny", reason: "missing-user" } }));
  },
});
```

## 内存事件

事件和关口在 provides 声明后，由内核在 setup 前建立暂存登记，安装成功时统一发布，无需提供 undefined 实现。事件提供者通过本地名称发布，订阅者声明依赖后监听。载荷经过验证和快照，监听串行运行。事件失败会停止该监听；事件不提供持久化、确认或重放。

```ts
declare const changed: EventToken<{ id: string }>;
const publisherPlugin = definePlugin({
  name: "publisher", provides: { changed },
  setup() { return { ok: true, value: undefined }; },
});
const listenerPlugin = definePlugin({
  name: "listener", requires: { changed },
  setup(ctx) { return ctx.on("changed", async (payload, _origin, call) => { void payload.id; void call.signal; }); },
});
```

监听者不能通过声明依赖取得发布权限。若消费者需要提交消息，由提供者暴露受控服务。容量不足的监听等待实际工作释放容量后重试；撤销监听会移除等待和排队载荷。

## 后台任务

显式后台任务归插件生命周期；任务中的依赖仍通过 call.deps 调用。需要结果的宿主应保存 TaskHandle 并 wait。取消或超时回执不表示实际函数已经结束。

```ts
const taskPlugin = definePlugin({
  name: "refresh", requires: { userStore },
  setup(ctx) {
    return ctx.startTask({ label: "refresh-user", run(call) { return call.deps.userStore.findUser({ id: "42" }); } });
  },
});
```

## 宿主管理与动态装卸

宿主使用 install、uninstall、createScope、closeScope、close、inspect。宿主通过 token 使用服务或登记能力；插件作者通过 definePlugin 获得类型化的命名接口。on 只监听事件，middleware 登记链中间件，guard 登记决策处理器，handle 提供链终结者。两者进入相同登记、执行和生命周期机制。

```ts
async function mount(app: Host, plugin: Plugin): Promise<Result<void>> {
  const installed = await app.install([plugin]);
  if (!installed.ok) return installed;
  const removed = await app.uninstall(installed.value.plugins[0]!);
  if (!removed.ok) return removed;
  return { ok: true, value: undefined };
}
```

被依赖的提供者默认拒绝卸载。cascade 显式选择同时停止依赖闭包。替换依赖时由宿主卸载、清理并重新装配；代码导入、文件监听、包管理、重启与流量切换属于外部宿主。

子范围组织可见性和资源。宿主通过 register 显式登记 token；shadow 必须显式声明，不会通过插件包装器改变范围。

```ts
function isolated(app: Host, token: ServiceToken<Greeting>) {
  const scope = app.createScope({ label: "tenant" });
  if (!scope.ok) return scope;
  return scope.value.register(token, { async greet(input) { return { ok: true, value: input.name }; } }, { shadow: true });
}
```

Scope 不是不可信代码沙箱。强制结束不可收敛代码需要进程或 Worker 隔离。

## 状态和故障

所有装配、登记、调用和关闭失败返回 Result。内核错误带 source: core 与稳定 code；业务失败保持业务类型。inspect 和 diagnostics 返回只读快照。清理失败、实际未结束工作和未释放资源不会被成功回执掩盖。

```ts
function inspectApplication(app: Host) {
  const state = app.inspect();
  return {
    dependencies: state.plugins.map(({ ref, dependencies }) => ({ plugin: ref.name, dependencies })),
    work: state.work,
    resources: state.resources,
    diagnostics: app.diagnostics(),
  };
}
```

## 验证

在 packages/v2 运行 bun run lint、bun run typecheck、bun run build、bun run test。测试在 Bun 运行，包含公共接口回归、类型负例、GC 检查、应用组合和覆盖率门禁。普通服务端组合使用真实 HTTP 与 SQLite，不依赖 AI 包。

inspect 的 work 能看到任务标签、服务方法、执行插件、资源拥有者和等待关系。任务已取消但函数还没有返回时，仍然留在这里。resources 能看到资源种类、归属、清理依赖和 active/closing/failed 状态；plugins 能看到固定提供者和可选依赖是否缺席。

缺依赖、卸载受阻和关闭未完成会返回定位详情。错误内的 diagnosticId 对应 diagnostics 的记录；每份列表最多展示 8 条并报告总数与省略数，完整关系由 inspect 获取。这里只输出元数据；任务 label 请使用稳定名称，避免填写连接串或凭据。
