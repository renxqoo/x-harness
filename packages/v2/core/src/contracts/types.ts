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
  readonly remainingMs: number;
  readonly origin: Origin;
  readonly originId: string;
  readonly originSignal: AbortSignal;
  readonly initiator: OwnerInspection;
  readonly executor: Origin;
  readonly resourceOwner: Origin;
  readonly phase: "activation" | "business" | "observer" | "cleanup";
  cancel(reason?: "cancelled" | "timeout"): Result<void>;
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

