export type MaybePromise<T> = T | PromiseLike<T>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type CoreFaultCode = (typeof import("./fault-codes").coreFaultCodes)[number];

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
  | { readonly ok: false; readonly reason: E | CoreFault };

export type Validator<T> = (input: unknown) => Result<T>;

export type ScopeState = "open" | "closing" | "closed" | "close-failed";
export type PluginState = "staging" | "active" | "stopping" | "stopped" | "failed";
export type TaskState = "pending" | "running" | "settled";

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
  R extends { readonly ok: false; readonly reason: infer E } ? E : never,
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
  readonly id: string;
  readonly parentId?: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly origin: Origin;
  readonly executor: Origin;
  readonly resourceOwner: Origin;
  readonly phase: "activation" | "business" | "observer" | "cleanup";
  bind(context: Context): Result<DependencyContext>;
  effect(disposer: Disposer): Result<Disposer>;
  spawn<T, E = never>(spec: TaskSpec<T, E>): Result<TaskHandle<T, E>>;
  wait<T, E = never>(task: TaskHandle<T, E>, options?: CallOptions): Promise<Result<T, E>>;
}

export interface DependencyContext {
  readonly id: string;
  readonly signal: AbortSignal;
  use<S>(token: ServiceToken<S>): Result<S>;
  dispatch<I, O, E>(token: ChainToken<I, O, E>, input: I, options?: CallOptions): Promise<Result<O, E>>;
  dispatch<I>(token: GuardToken<I>, input: I, options?: CallOptions): Promise<Result<GuardDecision>>;
}

export interface CleanupContext extends DependencyContext {}

export interface CleanupInvocation {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly context: CleanupContext;
}

export type Disposer = (cleanup: CleanupInvocation) => MaybePromise<Result<void>>;

export interface TaskSpec<T, E = never> {
  readonly label: string;
  readonly run: (call: Invocation) => MaybePromise<Result<T, E>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TaskHandle<T, E = never> {
  readonly id: string;
  readonly state: TaskState;
  readonly valueType?: (value: T) => T;
  readonly errorType?: (value: E) => E;
  cancel(reason?: string): Result<void>;
}

export interface Continuation<T> extends PromiseLike<T> {
  then<TFulfilled = T, TRejected = never>(
    fulfilled?: ((value: T) => TFulfilled | PromiseLike<TFulfilled>) | null,
    rejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Continuation<TFulfilled | TRejected>;
  catch<TRejected = never>(
    rejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
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

export interface ProvideOptions {
  readonly shadow?: boolean;
}

export type ProviderArguments<T> =
  T extends ServiceToken<infer S> ? [implementation: ServiceImplementation<S>, options?: ProvideOptions] :
  T extends ChainToken<infer I, infer O, infer E> ? [terminal: ChainTerminal<I, O, E>, options?: ProvideOptions] :
  T extends { readonly kind: "event" | "guard" } ? [] : never;

export type RegistrationHandler<T> =
  T extends ChainToken<infer I, infer O, infer E> ? ChainHandler<I, O, E> :
  T extends GuardToken<infer I> ? GuardHandler<I> :
  T extends EventToken<infer P> ? Observer<P> : never;

export interface Context {
  readonly id: string;
  readonly state: ScopeState;
  readonly signal: AbortSignal;
  provide<T extends DefinitionRef>(token: T, ...args: ProviderArguments<NoInfer<T>>): Result<Disposer>;
  use<S>(token: ServiceToken<S>): Result<S>;
  on<T extends DefinitionRef>(token: T, handler: RegistrationHandler<NoInfer<T>>): Result<Disposer>;
  dispatch<I, O, E>(token: ChainToken<I, O, E>, input: I, options?: CallOptions): Promise<Result<O, E>>;
  dispatch<I>(token: GuardToken<I>, input: I, options?: CallOptions): Promise<Result<GuardDecision>>;
  emit<T>(token: EventToken<T>, payload: T): Result<EmitReceipt>;
  effect(disposer: Disposer): Result<Disposer>;
  scope(options: ScopeOptions): Result<Context>;
  spawn<T, E = never>(spec: TaskSpec<T, E>): Result<TaskHandle<T, E>>;
  requestClose(reason?: string): Result<void>;
}

export interface Plugin {
  readonly name: string;
  readonly requires?: readonly DefinitionRef[];
  readonly optional?: readonly DefinitionRef[];
  readonly provides?: readonly DefinitionRef[];
  apply(ctx: Context, call: Invocation): MaybePromise<Result<void | Disposer, unknown>>;
}

export interface PluginRef {
  readonly name: string;
  readonly scopeId: string;
  readonly instanceId: string;
}

export interface LoadOptions {
  readonly scope?: Context;
}

export interface UnloadOptions {
  readonly cascade?: boolean;
}

export interface LoadReport {
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
}

export interface Inspection {
  readonly state: ScopeState;
  readonly degraded: boolean;
  readonly scopes: number;
  readonly plugins: readonly { readonly ref: PluginRef; readonly state: PluginState }[];
  readonly activeCalls: number;
  readonly serviceLeases: number;
  readonly activeTasks: number;
  readonly pendingEvents: number;
  readonly effects: number;
  readonly remainingTasks: readonly string[];
  readonly remainingEffects: readonly string[];
}

export interface RootContext extends Context {
  load(plugins: readonly Plugin[], options?: LoadOptions): Promise<Result<LoadReport>>;
  unload(plugin: PluginRef, options?: UnloadOptions): Promise<Result<CloseReport>>;
  closeScope(scope: Context): Promise<Result<CloseReport>>;
  dispose(): Promise<Result<CloseReport>>;
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
  readonly maxDefinitions: number;
  readonly maxRegistrationsPerOwner: number;
  readonly maxActiveTasks: number;
  readonly maxActiveCalls: number;
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

export interface ContextOptions {
  readonly limits?: Partial<Limits>;
  readonly scheduler?: Scheduler;
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
}

