# 公开接口与行为契约

## 1. 接口状态

本文件描述 core/src/index.ts 的公开契约。代码块声明类型和函数签名，运行实现位于 core/src。API 只描述通用机制；业务定义由外部插件公开。

所有异步控制入口返回 Result。同步登记和能力定义返回 Result；definePlugin 仅返回不可变插件声明，非法声明在 install 时拒绝。业务错误保持原错误类型，内核错误进入同一判别联合。同步读取的诊断与状态返回只读快照。

以下声明块固定公开接口。以 core/src 的公开导出为类型来源，文档与源码契约必须一致，示例对公开入口进行类型检查。

```ts
export type MaybePromise<T> = T | PromiseLike<T>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type CoreFaultCode =
  | "invalid-input"
  | "invalid-definition"
  | "invalid-result"
  | "definition-conflict"
  | "duplicate-provider"
  | "missing-dependency"
  | "undeclared-dependency"
  | "service-unavailable"
  | "extension-unavailable"
  | "extension-revoked"
  | "guard-unconfigured"
  | "dependency-cycle"
  | "plugin-in-use"
  | "plugin-not-found"
  | "activation-failed"
  | "activation-unsettled"
  | "resource-limit"
  | "scope-closed"
  | "cancelled"
  | "timeout"
  | "callback-failed"
  | "cleanup-failed"
  | "resource-conflict"
  | "close-incomplete"
  | "concurrent-next"
  | "late-next"
  | "unfinished-next"
  | "unobserved-next"
  | "wait-cycle";

export interface CoreFault {
  readonly source: "core";
  readonly code: CoreFaultCode;
  readonly message: string;
  readonly scopeId?: string;
  readonly pluginName?: string;
  readonly callId?: string;
  readonly diagnosticId?: string;
  readonly details?: JsonValue;
}

export type Result<T, E = never> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E | CoreFault };

export type Validator<T> = (input: unknown) => Result<T>;

export type ScopeState = "open" | "closing" | "closed" | "close-failed";
export type PluginState = "staging" | "active" | "stopping" | "stopped" | "failed";
export type TaskState = "running" | "settled";

export interface DefinitionRef {
  readonly kind: "service" | "chain" | "guard" | "event";
  readonly name: string;
}

export interface ServiceToken<S> extends DefinitionRef {
  readonly kind: "service";
  readonly serviceType?: (value: S) => S;
}

export interface ChainToken<I, O, E = never> extends DefinitionRef {
  readonly kind: "chain";
  readonly inputType?: (value: I) => I;
  readonly outputType?: (value: O) => O;
  readonly errorType?: (value: E) => E;
}

export interface GuardToken<I> extends DefinitionRef {
  readonly kind: "guard";
  readonly inputType?: (value: I) => I;
}

export interface EventToken<T> extends DefinitionRef {
  readonly kind: "event";
  readonly payloadType?: (value: T) => T;
}

export type ResultValue<R> =
  R extends { readonly ok: true; readonly value: infer T } ? T : never;
export type BusinessFailure<R> = Exclude<
  R extends { readonly ok: false; readonly error: infer E } ? E : never,
  CoreFault
>;
export type SameSignature<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
export type MethodSpec<F> =
  F extends (input: infer I) => Promise<infer R>
    ? SameSignature<F, (input: I) => Promise<R>> extends true
      ? [R] extends [Result<unknown, unknown>]
        ? {
            readonly input?: Validator<I>;
            readonly output?: Validator<ResultValue<R>>;
            readonly failure?: Validator<BusinessFailure<R>>;
          }
        : never
      : never
    : never;

export type ServiceImplementation<S> = {
  readonly [K in keyof S]:
    S[K] extends (input: infer I) => Promise<infer R>
      ? (input: I, call: Invocation) => Promise<R>
      : never;
};

export interface ServiceSpec<S> {
  readonly name: string;
  readonly methods: { readonly [K in keyof S]: MethodSpec<S[K]> };
}

export interface ChainSpec<I, O> {
  readonly name: string;
  readonly input: Validator<I>;
  readonly output: Validator<O>;
}

export interface GuardSpec<I> {
  readonly name: string;
  readonly input: Validator<I>;
}

export interface EventSpec<T> {
  readonly name: string;
  readonly payload: Validator<T>;
}

export interface Origin {
  readonly scopeId: string;
  readonly pluginName?: string;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface Invocation {
  readonly deps: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly parentId?: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly origin: Origin;
  readonly executor: Origin;
  readonly resourceOwner: Origin;
  readonly phase: "activation" | "business" | "observer" | "cleanup";
  bind(context: Context): Result<DependencyContext>;
  dispatch(name: string, input: unknown, options?: CallOptions): Promise<Result<unknown, unknown>>;
  effect(cleanup: Cleanup): Result<Disposer>;
  resource<T, E = never>(spec: ResourceSpec<T, E>): Promise<Result<T, E>>;
  spawn<T, E = never>(spec: TaskSpec<T, E>): Result<TaskHandle<T, E>>;
  wait<T, E = never>(task: TaskHandle<T, E>, options?: CallOptions): Promise<Result<T, E>>;
}

export interface DependencyContext {
  readonly scopeId: string;
  readonly signal: AbortSignal;
  use<S>(this: void, token: ServiceToken<S>): Result<S>;
  dispatch<I, O, E>(this: void, token: ChainToken<I, O, E>, input: I, options?: CallOptions): Promise<Result<O, E>>;
  dispatch<I>(this: void, token: GuardToken<I>, input: I, options?: CallOptions): Promise<Result<GuardDecision>>;
}

export interface CleanupContext extends DependencyContext {}

export interface CleanupInvocation {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly context: CleanupContext;
}

export type Cleanup = (invocation: CleanupInvocation) => MaybePromise<Result<void>>;

export interface ResourceSpec<T, E = never> {
  readonly open: (call: Invocation) => MaybePromise<Result<T, E>>;
  readonly close: (value: T, cleanup: CleanupInvocation) => MaybePromise<Result<void>>;
}

export type Disposer = () => MaybePromise<Result<void>>;

export interface TaskSpec<T, E = never> {
  readonly label: string;
  readonly run: (call: Invocation) => MaybePromise<Result<T, E>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TaskHandle<T, E = never> {
  readonly finished: Promise<Result<T, E>>;
  readonly id: string;
  readonly state: TaskState;
  readonly valueType?: (value: T) => T;
  readonly errorType?: (value: E) => E;
  cancel(): Result<void>;
}

export interface Continuation<T> extends PromiseLike<T> {
  then<TFulfilled = T, TRejected = never>(
    fulfilled?: ((value: T) => TFulfilled | PromiseLike<TFulfilled>) | null,
    rejected?: ((error: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Continuation<TFulfilled | TRejected>;
  catch<TRejected = never>(
    rejected?: ((error: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Continuation<T | TRejected>;
  finally(settled?: (() => void) | null): Continuation<T>;
}

export type Next<I, O, E = never> = (input: I) => Continuation<Result<O, E>>;
export type ChainHandler<I, O, E = never> =
  (input: I, next: Next<I, O, E>, call: Invocation) => MaybePromise<Result<O, E>>;
export type ChainTerminal<I, O, E = never> =
  (input: I, call: Invocation) => MaybePromise<Result<O, E>>;

export type GuardDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export type GuardHandler<I> =
  (input: I, call: Invocation) => MaybePromise<Result<GuardDecision>>;

export interface EventOrigin extends Origin {
  readonly emissionId: string;
  readonly sequence: number;
}

export type Observer<T> =
  (payload: T, origin: EventOrigin, call: Invocation) => MaybePromise<void>;

export interface EmitReceipt {
  readonly emissionId: string;
  readonly acceptedListeners: number;
}

export interface ScopeOptions {
  readonly label: string;
  readonly limits?: Partial<Limits>;
}

export interface RegistrationOptions {
  readonly shadow?: boolean;
}

export type ProviderArguments<T> =
  T extends ServiceToken<infer S> ? [implementation: ServiceImplementation<S>, options?: RegistrationOptions] :
  T extends ChainToken<infer I, infer O, infer E> ? [terminal: ChainTerminal<I, O, E>, options?: RegistrationOptions] :
  T extends { readonly kind: "event" | "guard" } ? [] : never;

export interface Context {
  readonly deps: Readonly<Record<string, unknown>>;
  readonly scopeId: string;
  readonly scopeState: ScopeState;
  readonly signal: AbortSignal;
  service(implementations: Readonly<Record<string, unknown>>, options?: RegistrationOptions): Result<Readonly<Record<string, Disposer>>>;
  handle<I, O, E>(token: ChainToken<I, O, E>, terminal: ChainTerminal<I, O, E>, options?: RegistrationOptions): Result<Disposer>;
  register<T extends DefinitionRef>(this: void, token: T, ...args: ProviderArguments<NoInfer<T>>): Result<Disposer>;
  use<S>(this: void, token: ServiceToken<S>): Result<S>;
  on<T>(token: EventToken<T>, handler: Observer<NoInfer<T>>): Result<Disposer>;
  middleware<I, O, E>(token: ChainToken<I, O, E>, handler: ChainHandler<NoInfer<I>, NoInfer<O>, NoInfer<E>>): Result<Disposer>;
  guard<I>(token: GuardToken<I>, handler: GuardHandler<NoInfer<I>>): Result<Disposer>;
  dispatch<I, O, E>(this: void, token: ChainToken<I, O, E>, input: I, options?: CallOptions): Promise<Result<O, E>>;
  dispatch<I>(this: void, token: GuardToken<I>, input: I, options?: CallOptions): Promise<Result<GuardDecision>>;
  emit<T>(this: void, token: EventToken<T>, payload: T): Result<EmitReceipt>;
  addCleanup(cleanup: Cleanup): Result<Disposer>;
  resource<T, E = never>(spec: ResourceSpec<T, E>): Promise<Result<T, E>>;
  createScope(options: ScopeOptions): Result<Context>;
  startTask<T, E = never>(spec: TaskSpec<T, E>): Result<TaskHandle<T, E>>;
  requestClose(): Result<void>;
}

export interface Plugin {
  readonly name: string;
  readonly requires?: Readonly<Record<string, DefinitionRef>>;
  readonly optional?: Readonly<Record<string, DefinitionRef>>;
  readonly provides?: Readonly<Record<string, DefinitionRef>>;
  setup(ctx: Context, call: Invocation): MaybePromise<Result<unknown, unknown>>;
}

export interface PluginRef {
  readonly name: string;
  readonly scopeId: string;
  readonly instanceId: string;
}

export interface InstallOptions {
  readonly scope?: Context;
}

export interface UninstallOptions {
  readonly cascade?: boolean;
}

export interface InstallReport {
  readonly plugins: readonly PluginRef[];
}

export interface CloseReport {
  readonly scopeId: string;
  readonly stoppedPlugins: readonly PluginRef[];
  readonly settledTasks: number;
  readonly releasedEffects: number;
}

export interface Diagnostic {
  readonly id: string;
  readonly time: number;
  readonly code: CoreFaultCode;
  readonly scopeId: string;
  readonly pluginName?: string;
  readonly callId?: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface OwnerInspection {
  readonly id: string;
  readonly kind: "host" | "plugin";
  readonly scopeId: string;
  readonly pluginName?: string;
}

export interface ProviderInspection {
  readonly id: string;
  readonly definition: DefinitionRef;
  readonly owner: OwnerInspection;
}

export interface DependencyInspection {
  readonly name: string;
  readonly definition: DefinitionRef;
  readonly optional: boolean;
  readonly provider: ProviderInspection | null;
}

export interface WorkInspection {
  readonly id: string;
  readonly kind: "call" | "task";
  readonly phase: Invocation["phase"];
  readonly label?: string;
  readonly executor: OwnerInspection;
  readonly resourceOwner: OwnerInspection;
  readonly parentId?: string;
  readonly cancelled: boolean;
  readonly bodyComplete: boolean;
  readonly waitingFor: readonly string[];
}

export interface ResourceInspection {
  readonly id: string;
  readonly kind: "cleanup" | "resource" | "provider" | "registration";
  readonly owner: OwnerInspection;
  readonly executor: OwnerInspection;
  readonly state: "active" | "closing" | "failed";
  readonly dependencies: readonly ProviderInspection[];
}

export interface Inspection {
  readonly state: ScopeState;
  readonly degraded: boolean;
  readonly scopes: number;
  readonly plugins: readonly {
    readonly ref: PluginRef;
    readonly state: PluginState;
    readonly dependencies: readonly DependencyInspection[];
    readonly provides: readonly ProviderInspection[];
  }[];
  readonly activeWaits: number;
  readonly activeCalls: number;
  readonly serviceLeases: number;
  readonly activeTasks: number;
  readonly pendingEvents: number;
  readonly effects: number;
  readonly work: readonly WorkInspection[];
  readonly resources: readonly ResourceInspection[];
}

export interface Host extends Context {
  install(plugins: readonly Plugin[], options?: InstallOptions): Promise<Result<InstallReport>>;
  uninstall(plugin: PluginRef, options?: UninstallOptions): Promise<Result<CloseReport>>;
  closeScope(scope: Context): Promise<Result<CloseReport>>;
  close(): Promise<Result<CloseReport>>;
  wait<T, E = never>(task: TaskHandle<T, E>, options?: CallOptions): Promise<Result<T, E>>;
  inspect(): Inspection;
  diagnostics(): readonly Diagnostic[];
}

export interface Limits {
  readonly maxScopes: number;
  readonly maxPluginsPerScope: number;
  readonly maxPlugins: number;
  readonly maxEffects: number;
  readonly maxServiceLeases: number;
  readonly maxServiceLeasesPerOwner: number;
  readonly maxDefinitions: number;
  readonly maxRegistrationsPerOwner: number;
  readonly maxActiveTasks: number;
  readonly maxActiveCalls: number;
  readonly maxActiveWaits: number;
  readonly maxPendingEvents: number;
  readonly maxEventBytes: number;
  readonly maxEventDepth: number;
  readonly maxEventNodes: number;
  readonly maxNextCallsPerFrame: number;
  readonly maxCallDepth: number;
  readonly maxDiagnostics: number;
  readonly maxPendingMutations: number;
  readonly callTimeoutMs: number;
  readonly activationTimeoutMs: number;
  readonly observerTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

export interface Scheduler {
  now(): number;
  delay(callback: () => void, delayMs: number): () => void;
}

export interface HostOptions {
  readonly limits?: Partial<Limits>;
  readonly scheduler?: Scheduler;
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
}


export type TokenMap = Readonly<Record<string, DefinitionRef>>;
type ServiceOf<T> = T extends ServiceToken<infer S> ? S : never;
export type Dependencies<D extends TokenMap> = {
  readonly [K in keyof D as D[K] extends { readonly kind: "service" } ? K : never]: ServiceOf<D[K]>;
};
export type PluginDependencies<D extends TokenMap, O extends TokenMap> = Dependencies<D> & Partial<Dependencies<O>>;

export interface PluginResource<T, E, D extends TokenMap, P extends TokenMap, O extends TokenMap> {
  readonly open: (call: PluginInvocation<D, P, O>) => MaybePromise<Result<T, E>>;
  readonly close: (value: T, cleanup: CleanupInvocation) => MaybePromise<Result<void>>;
}

export interface PluginTask<T, E, D extends TokenMap, P extends TokenMap, O extends TokenMap> extends CallOptions {
  readonly label: string;
  readonly run: (call: PluginInvocation<D, P, O>) => MaybePromise<Result<T, E>>;
}

export interface PluginInvocation<D extends TokenMap, P extends TokenMap, O extends TokenMap> extends Omit<Invocation, "deps" | "resource" | "spawn" | "dispatch"> {
  readonly deps: PluginDependencies<D, O>;
  dispatch<K extends Keys<D & P & O, "chain" | "guard">>(name: K, input: Dispatch<(D & P & O)[K]>[0], options?: CallOptions): Promise<Dispatch<(D & P & O)[K]>[1]>;
  resource<T, E = never>(spec: PluginResource<T, E, D, P, O>): Promise<Result<T, E>>;
  spawn<T, E = never>(spec: PluginTask<T, E, D, P, O>): Result<TaskHandle<T, E>>;
}

type Implementation<T, D extends TokenMap, P extends TokenMap, O extends TokenMap> =
  T extends ServiceToken<infer S> ? {
    readonly [K in keyof S]: S[K] extends (input: infer I) => Promise<infer R>
      ? (input: I, call: PluginInvocation<D, P, O>) => Promise<R> : never;
  } : T extends ChainToken<infer I, infer R, infer E>
    ? (input: I, call: PluginInvocation<D, P, O>) => MaybePromise<Result<R, E>>
    : never;

export type PluginImplementations<P extends TokenMap, D extends TokenMap, O extends TokenMap> = {
  readonly [K in keyof P as P[K] extends { readonly kind: "service" } ? K : never]: Implementation<P[K], D, P, O>;
};

type Handler<T, D extends TokenMap, P extends TokenMap, O extends TokenMap> =
  T extends ChainToken<infer I, infer R, infer E> ? (input: I, next: Next<I, R, E>, call: PluginInvocation<D, P, O>) => MaybePromise<Result<R, E>>
    : T extends GuardToken<infer I> ? (input: I, call: PluginInvocation<D, P, O>) => MaybePromise<Result<GuardDecision>>
      : T extends EventToken<infer I> ? (input: I, origin: import("./types").EventOrigin, call: PluginInvocation<D, P, O>) => MaybePromise<void> : never;

type Dispatch<T> = T extends ChainToken<infer I, infer R, infer E> ? [input: I, result: Result<R, E>]
  : T extends GuardToken<infer I> ? [input: I, result: Result<GuardDecision>] : never;
type Keys<T extends TokenMap, Kind extends DefinitionRef["kind"]> = {
  [K in keyof T]: T[K] extends { readonly kind: Kind } ? K : never;
}[keyof T];

export interface PluginContext<D extends TokenMap, P extends TokenMap, O extends TokenMap> extends Omit<
  Context, "deps" | "service" | "handle" | "register" | "use" | "on" | "middleware" | "guard" | "dispatch" | "emit" | "resource" | "startTask"
> {
  readonly deps: PluginDependencies<D, O>;
  service<const I extends PluginImplementations<P, D, O>>(implementations: I & Record<Exclude<keyof I, Keys<P, "service">>, never>, options?: RegistrationOptions): Result<{ readonly [K in keyof P as P[K] extends { readonly kind: "service" } ? K : never]: Disposer }>;
  handle<K extends Keys<P, "chain">>(name: K, terminal: Implementation<P[K], D, P, O>, options?: RegistrationOptions): Result<Disposer>;
  middleware<K extends Keys<D & P & O, "chain">>(name: K, handler: Handler<(D & P & O)[K], D, P, O>): Result<Disposer>;
  guard<K extends Keys<D & P & O, "guard">>(name: K, handler: Handler<(D & P & O)[K], D, P, O>): Result<Disposer>;
  on<K extends Keys<D & P & O, "event">>(name: K, handler: Handler<(D & P & O)[K], D, P, O>): Result<Disposer>;
  dispatch<K extends Keys<D & P & O, "chain" | "guard">>(name: K, input: Dispatch<(D & P & O)[K]>[0], options?: CallOptions): Promise<Dispatch<(D & P & O)[K]>[1]>;
  emit<K extends Keys<P, "event">>(name: K, payload: P[K] extends EventToken<infer I> ? I : never): Result<import("./types").EmitReceipt>;
  resource<T, E = never>(spec: PluginResource<T, E, D, P, O>): Promise<Result<T, E>>;
  startTask<T, E = never>(spec: PluginTask<T, E, D, P, O>): Result<TaskHandle<T, E>>;
}

export interface PluginSpec<D extends TokenMap, P extends TokenMap, O extends TokenMap> {
  readonly name: string;
  readonly requires?: D;
  readonly provides?: P;
  readonly optional?: O;
  readonly setup: (ctx: PluginContext<NoInfer<D>, NoInfer<P>, NoInfer<O>>) => MaybePromise<Result<unknown, unknown>>;
}


export declare function defineService<S>(spec: ServiceSpec<S>): Result<ServiceToken<S>>;
export declare function defineChain<I, O, E = never>(spec: ChainSpec<I, O>): Result<ChainToken<I, O, E>>;
export declare function defineGuard<I>(spec: GuardSpec<I>): Result<GuardToken<I>>;
export declare function defineEvent<T>(spec: EventSpec<T>): Result<EventToken<T>>;
export declare function createHost(options?: HostOptions): Result<Host>;
export declare function validatePlugin(input: unknown): Result<Plugin>;
export declare function definePlugin<const D extends TokenMap = Record<never, never>, const P extends TokenMap = Record<never, never>, const O extends TokenMap = Record<never, never>>(spec: PluginSpec<D, P, O>): Plugin;
```

## 2. 声明与装配

名称采用小写标识分段，以 `/` 分隔；每段匹配 `[a-z][a-z0-9-]*`，总长不超过 160 个 ASCII 字符。`core/` 前缀保留给宿主内部诊断。业务不受预设名称清单限制。

validatePlugin 对未知输入执行无副作用的声明预检，验证真实 token 身份并返回冻结快照，不执行 setup，也不安装插件。装配与外部自动装配器共用这一校验。

声明工厂不产生副作用。非法输入返回 invalid-definition。服务 methods 逐项描述公开方法；方法只有一个必需 input 参数，无输入时使用 void。不允许公开属性、嵌套对象、同步方法、第二可选参数、rest、重载或泛型公开签名。不强制方法输入输出可序列化。

工厂保存不可变描述，schema、错误形态和方法映射来自同一份契约。校验器本身抛错时转换为 callback-failed，不冒充校验成功。

插件的 requires、optional、provides 均为本地名称到 token 的映射。provides 可以包含四类契约。setup 通过 ctx.service 交付声明中的服务实现全集，通过 ctx.handle 交付已声明 chain 的终结处理器。guard/event 在本插件 setup 前自动建立暂存登记，成功后随批次统一发布。宿主通过 Context.register(token, ...) 显式登记能力。缺少服务实现或 chain 终结者、提供未声明契约，均拒绝提交。on 只登记事件，middleware 只登记链中间件，guard 只登记决策处理器；错误种类会被类型和运行边界拒绝。

requires 与 optional 不得交叉或重复；不声明对自身 provides 的依赖。两个插件在一个装配作用域不能声明相同提供项。没有 chain 提供者时，dispatch 返回 extension-unavailable。

## 3. Result 与错误

Result 顶层只包含 ok 和对应 value 或 error。不能同时出现 value 与 error，也不能用 undefined 充当失败结果。error 内的业务对象保持原有形态，Guard deny 的 reason 表达拒绝原因。装配和关闭属于宿主控制操作，返回 CoreFault，并通过诊断身份报告插件激活或清理失败，不把 unknown 直接当作宿主公开错误。

意外抛出的异常转换为 CoreFault，原异常不直接进入业务结果或默认诊断。默认诊断不包含输入、输出、凭据和任意错误对象。宿主记录受限长度的中性消息和位置；敏感数据审计由外部插件定义。

CoreFault 通过保留字段 source: "core" 与业务失败区分，不能只根据 code 或 message 判断。业务错误不能占用此来源判别，可以使用自己的 code，包括 timeout。failure validator 只接收业务失败，CoreFault 由内核校验，不混进业务错误推断。

读取缺席服务返回 service-unavailable。无效输入、不可见定义和关闭后调用返回明确失败，不崩溃，也不伪造成功。inspect 和 diagnostics 返回空集合或当前快照，不暴露可写内部引用。

## 4. 服务调用

消费者调用正常的方法对象，不传 Invocation。提供者方法收到 core 生成的 Invocation。输入中的同名字段不能覆盖 core 的身份、来源、signal 或 deadline。

提供者实现只能包含声明的方法，且方法为自身数据属性中的函数；不得触发 getter 取得实现。服务门面不可修改，绑定的提供者不随注册表变化而重定向。

实际调用前验证消费方、提供方、代次和预算；方法 input validator 在执行前运行，output/failure validator 在结果返回前运行。没有配置 validator 的进程内值按业务契约处理，core 不深拷贝它。

方法开始前先进入调用账本，finally 中按真实结算释放。超时可以先向调用者返回失败，同时取消 Invocation；底层 Promise 仍被观察和追踪。发生超时的同一调用不能迟到变为成功。

跨提供者、消费者和子调用传播取消，但不取消不相关的兄弟调用。取消监听器在实际结束时解除。

## 5. 调用链

输入每次进入处理器前校验，成功输出离开链前校验。原始错误结果保持原样，不被输出转换丢掉控制信息。

执行计划包括终结处理器、按作用域和装配顺序排列的中间件，以及它们的提供者代次。注销发生在执行计划捕获之后、处理器进入之前时，调用返回 extension-revoked；不能静默跳过该处理器。

短路返回 Result 是合法行为。next 可以顺序重试，但每次重新校验输入，增加 continuation 计数，并建立子调用身份。并发 next 返回 concurrent-next；返回后的 next 返回 late-next；取消后返回 cancelled。

next 返回局部 Continuation thenable，不依赖覆写原生 Promise.then 检测 await。await 和直接返回可转交观察责任；then/catch/finally 创建的每条派生链也必须被追踪，不能通过连接后丢弃派生链规避约束。Result 的业务失败与 Promise 拒绝分别记录；已观察不代表已处理业务失败。处理器结束时存在未结算 next 或内核创建的派生 Continuation，返回 unfinished-next 并取消子调用。未结束派生 Promise 保留在当前调用的实际收敛账本，不能释放提供者资源后任由它继续运行。结束时存在未观察的失败，返回 unobserved-next；宿主内部的防未处理拒绝观察不能算作插件观察。

观察检查仅覆盖 core 创建的 Continuation 链；已成功结算的未观察派生链合法。转交到原生 Promise 或其他容器后，core 不能判断该外部容器是否被丢弃，也不能区分 await 与 Promise.resolve 的吸收。插件仍须管理自己的外部 Promise，内核不声称检测所有异步逃逸。

对外 timeout 不释放 activeNext。底层工作实际结算前，新的 next 仍返回 concurrent-next，防止重试与未结束的前一次执行重叠。

实现不能通过简单 Promise.race 丢弃仍在运行的 continuation。

## 6. Guard

处理器只能返回明确 allow 或 deny 的 Result。没有处理器时为 guard-unconfigured。按顺序执行，首次 deny 返回该判断，不执行后续判断；处理器失败、非法结果或取消立即返回失败。

只有全部明确 allow 才返回 allow。core 不把 undefined、异常或超时理解成默认允许。

## 7. Event

emit 在入队前调用 payload validator 并创建 JSON 快照。拒绝循环引用、访问器、非有限数字、函数、符号、异常原型和超过限制的结构。禁止从字符串内容猜测业务来源。

payload 对观察者是只读快照，Origin 由 core 填充。序号是本宿主内的通知接受顺序，不是持久序号，也不提供跨宿主排序。

入队容量按实际监听投递数预留。容量不足时整个 emit 拒绝，没有一半监听者接受、一半被悄悄丢弃的结果。无监听者返回 acceptedListeners 为 0 的成功回执。

同一监听者 FIFO 且最多一个实际在途观察调用。观察超时后取消该调用并暂停该监听者，撤销其未开始队列；底层结束前不能开始同监听者的下一条通知。其他监听者继续运行。重新注册是恢复监听的明确操作。

## 8. 任务、资源与关闭

ctx.startTask 创建归当前拥有者管理的任务，可以用于明确的后台工作。call.spawn 创建结构化子任务，父调用结束前必须收敛；未显式等待的子任务由父调用连接等待，未处理子任务失败进入父调用失败。子任务第一次 timeout/cancelled 结算也属于失败，底层迟到成功不能被自动连接等待当作成功。

插件执行中用 Invocation.wait 等待任务，宿主用 Host.wait。等待图包含显式 wait、结构化父子任务、绑定后的嵌套调用、continuation 及自动连接等待。任务执行 Invocation.id 与 TaskHandle.id 使用同一工作身份，子任务等待父任务也能检出 wait-cycle。等待超时只终止等待，不自动取消目标任务；取消通过 TaskHandle.cancel 明确发起。

definePlugin 的处理器通过 call.deps 和 call.dispatch 使用绑定本次调用的依赖。底层宿主 Context 也可以通过 call.bind(ctx) 获得受限依赖门面，再 use 或 dispatch。绑定继承 parentId、取消、截止时间和剩余预算；不绑定的 ctx.use 属于拥有者级调用，不自动推断异步父调用。bind 只接受本宿主当前执行者拥有或获准使用的子作用域，不扩大依赖权限。业务调用不能逃逸为后台任务；需要后台工作时明确使用 ctx.startTask。

TaskHandle.state 以实际 Promise 结算为准，不能在发出取消信号时提前变成 settled。

提供者登记 disposer 的手动调用先检查活跃消费者、清理依赖与在途工作，包括同拥有者的其他资源清理依赖；仍被使用时返回 plugin-in-use，不开始释放，也不缓存为清理失败。宿主关闭与卸载先完成对应停止和依赖排序。

addCleanup 与 call.effect 登记立即建立拥有关系；同一拥有者重复登记同一 disposer 函数复用同一资源。跨拥有者登记返回 resource-conflict，不隐式转移。同一 disposer 并发或重复执行返回同一结算，不自动重试失败清理。

setup 的成功值不解释为清理回调；service/handle/on/middleware/guard/addCleanup 的回执已经归属插件，返回它不会重复登记。resource 在分配之前登记清理并预留预算，open 收到独立受管调用上下文。成功交付的资源随归属者关闭；取消或超时后未交付的迟到资源在取得实际结束后立即回收，失败保留账本和清理依赖。resource 返回 Result<T>，不提供裸值的内核提前释放句柄；提前关闭使用独立受管子范围。部分分配但未交付句柄的 adapter 自己负责补偿。

关闭子树时先等待子树实际工作结算，在保留全部提供者能力和长期资源的清理模式下释放 Invocation.effect 消费方资源，再按依赖逆序关闭插件自身资源；不能仅按插件安装倒序把宿主资源留到最后。

资源记录分别保存生命周期拥有者与清理执行者。ctx.addCleanup 的二者均为当前插件；Invocation.effect 的拥有者为 resourceOwner，清理执行者为当前 executor。绑定的嵌套调用保留 resourceOwner，origin 则记录实际直接调用者。清理执行者的已声明依赖及本身提供项固定到资源释放，参与卸载保护。

CleanupInvocation.context 使用 CleanupContext 窄接口，只能 use/dispatch 资源清理执行者的已固定依赖。清理 lease 允许调用已经 stopping、尚未最终释放的提供者，使用独立清理 signal，绕过关闭中的业务准入与已取消业务 signal；调用仍计入提供者真实 drain。消费者清理调用结束前，提供者不能最终释放。cleanup 阶段的 bind 保留此限制，不能恢复业务准入。

关闭截止时间不重新开始。回执在实际完成时也检查单调时钟，超过截止时间返回 close-incomplete，即使计时器尚未获得执行机会；实际释放成功仍可最终收敛为 closed。迟到 disposer 仍执行，收到已经中止的清理 signal；只有真实清理成功且全部工作结算才可收敛为 closed。清理失败或拒绝释放保持 close-failed。

作用域关闭同时释放该子树向外创建的受管消费方资源；外部资源拥有者不必随之关闭。这些清理使用当前作用域的关闭截止时间，不能因拥有者位于外部而重新扩大预算。

Plugin Context 的 requestClose 只请求自身拥有者或自己创建的作用域停止，不能请求祖先或兄弟关闭。提供者存在依赖者时，自关闭请求返回 plugin-in-use；级联由宿主决定。根 Context 的 requestClose 请求整个宿主停止。

等待式 close 只存在于 Host。重复 close 返回同一 Promise；closeScope 对同一作用域也复用关闭操作。超过 closeTimeoutMs 返回 close-incomplete，剩余工作继续被账本追踪。若之后实际收敛，inspect 可以反映 closed；先前的失败回执不改写。

清理失败导致 close-failed；仍继续释放其他资源。没有隐式重试清理、强制丢弃账本或把异常转换为关闭成功。

## 9. 限制与时间

| 配置 | 默认值 | 计数范围 |
| --- | --- | --- |
| maxScopes | 1024 | 根宿主内全部作用域 |
| maxPluginsPerScope | 128 | 每个装配作用域，包含 staging/stopping |
| maxPlugins | 2048 | 根宿主插件总量，包含 staging/stopping |
| maxEffects | 8192 | 根宿主全部受管资源与登记 |
| maxServiceLeases | 8192 | 根宿主全部有效服务门面绑定（稳定消费关系；请求内临时依赖门面不计入） |
| maxServiceLeasesPerOwner | 4096 | 每个资源拥有者的稳定服务门面绑定 |
| maxDefinitions | 2048 | 根宿主活跃定义及有引用的定义 |
| maxRegistrationsPerOwner | 1024 | 每个资源拥有者 |
| maxActiveTasks | 2048 | 根宿主实际未结算任务 |
| maxActiveCalls | 4096 | 根宿主实际未结算调用 |
| maxPendingEvents | 1024 | 根宿主尚未开始的监听投递 |
| maxEventBytes | 65536 | 一个 JSON 快照的 UTF-8 编码 |
| maxEventDepth | 32 | 一个 JSON 快照 |
| maxEventNodes | 10000 | 一个 JSON 快照 |
| maxNextCallsPerFrame | 16 | 一次中间件进入 |
| maxCallDepth | 64 | 一条调用祖先链 |
| maxDiagnostics | 256 | 根宿主诊断环形缓冲 |
| maxPendingMutations | 128 | 根宿主等待的装配/卸载操作 |
| callTimeoutMs | 30000 | 默认服务、chain、guard、任务与等待 |
| activationTimeoutMs | 10000 | 单插件激活 |
| observerTimeoutMs | 5000 | 单观察者 |
| closeTimeoutMs | 30000 | 一个关闭操作的完整预算 |

计数限制是默认资源预算，不是性能承诺。数量必须为正安全整数；时间必须为正有限整数。非法配置返回 invalid-input，不静默修正。

子作用域只能收紧祖先限制。所有适用祖先均参与准入，不能通过不断创建子作用域绕过总量限制。

显式 timeoutMs 不能延长既有父调用截止时间。now 使用单调时间；clock 和 timer 归本宿主，关闭后没有遗留 timer。等待、事件、激活和关闭的计时器分别登记，重复关闭不重置预算。

## 10. 宿主装配接口

install 的发布单位是一个批次。InstallOptions.scope 必须属于本宿主且为 open。uninstall 默认拒绝存在已绑定消费者的提供者；cascade 明确按逆依赖顺序关闭。

同一根宿主的 install/uninstall 操作统一串行化，包括祖先与子作用域。发布前重新检查祖先状态、固定依赖代次与预算。关闭信号绕过 mutation 队列，能取消正在激活的插件。关闭不是一项排在 hung activation 后面的普通 mutation。

install 失败的 Result 保留首次失败原因的归因：setup 返回业务失败报 activation-failed，业务错误可归一化为 JSON（Error 实例归一为 {name, message}）时在 details.cause 保留，否则省略 details；setup 抛出异常报 callback-failed；声明能力未兑现报 activation-failed；发布阶段失败原样返回该阶段的精确错误码（duplicate-provider、resource-limit 等）。setup 与发布阶段的失败带 pluginName；作用域已关闭等批次级检查无法归属到插件，仅带 scopeId。

关闭未收敛的 staging 批次保留账本并标记 degraded，新的装配返回 activation-unsettled，不假装锁和资源已经释放。其他已发布能力是否仍可调用由其自身拥有者状态决定。宿主可以请求全局关闭，强制终止由外部执行宿主处理。

事件或 guard 的 ctx.service 是定义拥有者登记。只有提供者可以直接 emit 自己的事件；订阅者通过 requires/optional 接入。需要让消费者发出业务事件时，提供者应公开受控服务。宿主 Context 可以显式 emit 可见的公开事件。

在线安装处理器只影响后续捕获的执行计划；已进入调用不重新拼接计划。已捕获但尚未进入的处理器撤销仍返回 extension-revoked。服务依赖不因新安装而自动重绑。

## 11. 明确不提供的接口

不提供按字符串动态 use、不提供永远等待提供者出现的 waitFor、不提供第二套 createChain/onChain、不提供可覆盖原始实现的热替换别名。

不提供 messages、tools、model、room、bot、checkpoint、durableQueue 或任何业务接口。这些由外部插件通过服务和扩展点契约提供。

级联卸载将所选插件创建的全部子作用域纳入生命周期闭包；其中复制固定依赖的作用域拥有者不算独立宿主消费者。真正的外部宿主依赖仍阻断卸载。关闭回执中的 stoppedPlugins 仅列插件实例，不列作用域拥有者。

CoreFault 保留 source="core"；内核完整检查错误码、字符串身份和不可变 JSON details。details 校验上限为深度 32、节点 10000、编码字节 65536，超限或非法结构返回 invalid-result。error 内的业务对象仍遵循业务自身契约。

wait 的 timeoutMs 缺省采用调用默认预算，结果交付时检查固定 deadline；超时或取消只终止等待，不取消目标，也不把未取得的目标失败标成已观察。maxActiveWaits 限制并行等待，inspect.activeWaits 反映当前等待数。

## 12. 运行诊断

Host.inspect() 返回同步、深冻结的当前快照。plugins[].dependencies 显示声明的本地名称、定义、是否可选及实际固定提供者；optional 缺席时 provider 为 null。plugins[].provides 列出提供者身份。跨范围同名插件通过 scopeId 与实例 id 区分。

work 列出实际尚未结束的调用和任务；label 显示任务标签、服务方法、扩展点或 setup/resource.open；executor 表示执行者，resourceOwner 表示资源生命周期拥有者。parentId 和 waitingFor 显示父子工作与等待边；waitingFor 包含结构化父子连接，表示父项必须等待子项真正结束，并不保证当前函数体正停在 await 上。cancelled 表示信号已经取消，bodyComplete 表示函数体已经结束；两者都不代表实际工作已经排空。resources 包含 cleanup、resource、provider、registration 四类登记，state 为 active、closing 或 failed，并列出固定清理依赖。

missing-dependency 的 details.definition 指出缺失定义。plugin-in-use 的详情指出第一处阻塞提供者，并列出消费者、资源 pins 和相关工作。close-incomplete 的详情指出实际剩余 work、resources，手动关闭还带 resourceId。每个摘要列表结构为 { total, omitted, items }，最多采样 8 条。工作摘要 label 最多保留 160 个 UTF-16 代码单元，超过时带 labelTruncated: true；inspect 保留完整标签。手动清理通过资源与清理工作的临时关联定位，不混入同拥有者的其他清理。完整图由 inspect 获取。相关 scopeId、pluginName 与冻结详情同时进入 Result.error 和对应 Diagnostic；可通过 diagnosticId 关联。

诊断只复制身份和状态，不包含业务参数、业务返回值、连接值、函数、token 或原始异常。快照不随后续完成而变化，也不会延长运行对象的生命周期。宿主拥有完整检查权限；插件上下文不获得 inspect 或 diagnostics 方法。标签属于调用者提供的诊断元数据，应用应使用稳定名称。

TaskHandle.finished 等待任务和全部子工作真正结算，供宿主和生命周期适配器排空；取消和超时之后仍可能等待实际函数返回。受管调用内部使用 call.wait 维护等待图与调用期限。
