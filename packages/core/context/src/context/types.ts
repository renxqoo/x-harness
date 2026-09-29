export type Disposer = () => void | Promise<void>;

export interface ServiceToken<T> {
  readonly kind: "service";
  readonly name: string;
  readonly __service?: T;
}

export type FreezeMode = "deep" | "shell" | "none";

export interface EventToken<T> {
  readonly kind: "event";
  readonly mode: "emit";
  readonly name: string;
  readonly freeze: FreezeMode;
  readonly __payload?: T;
}

export interface WaterfallToken<I, O> {
  readonly kind: "waterfall";
  readonly mode: "waterfall";
  readonly name: string;
  readonly __input?: I;
  readonly __output?: O;
}

export interface SerialToken<T> {
  readonly kind: "serial";
  readonly mode: "serial";
  readonly name: string;
  readonly __payload?: T;
}

export interface GuardToken<T> {
  readonly kind: "guard";
  readonly mode: "guard";
  readonly name: string;
  readonly __payload?: T;
}

export interface ParallelToken<T> {
  readonly kind: "parallel";
  readonly mode: "parallel";
  readonly name: string;
  readonly __payload?: T;
}

export type AnyToken =
  | ServiceToken<unknown>
  | EventToken<unknown>
  | WaterfallToken<unknown, unknown>
  | SerialToken<unknown>
  | GuardToken<unknown>
  | ParallelToken<unknown>;

export interface RegisterOptions {
  readonly prepend?: boolean;
}

export interface GuardDeny {
  readonly kind: "deny";
  readonly reason: string;
}

export type ChainMiddleware<I, O> = (
  input: I,
  next: (input: I) => Promise<O>,
) => Promise<O>;

export interface Chain<I, O> {
  dispatch(input: I): Promise<O>;
}

export interface ChainEntry<I, O> {
  readonly layer: unknown;
  readonly middleware: ChainMiddleware<I, O>;
}

export interface ScopeFilter {
  readonly agentId: string;
}

export interface Context {
  provide<T>(token: ServiceToken<T>, impl: T): Disposer;
  use<T>(token: ServiceToken<T>): T;
  tryUse<T>(token: ServiceToken<T>): T | undefined;
  waitFor<T>(token: ServiceToken<T>): Promise<T>;

  on<T>(token: EventToken<T>, listener: (payload: T) => void, opts?: RegisterOptions): Disposer;
  on<I, O>(
    token: WaterfallToken<I, O>,
    middleware: ChainMiddleware<I, O>,
    opts?: RegisterOptions,
  ): Disposer;
  on<T>(token: SerialToken<T>, listener: (payload: T) => void, opts?: RegisterOptions): Disposer;
  on<T>(
    token: GuardToken<T>,
    listener: (payload: T) => GuardDeny | void | Promise<GuardDeny | void>,
    opts?: RegisterOptions,
  ): Disposer;
  on<T>(
    token: ParallelToken<T>,
    listener: (payload: T) => unknown,
    opts?: RegisterOptions,
  ): Disposer;

  emit<T>(token: EventToken<T>, payload: T): void;

  dispatch<I, O>(
    token: WaterfallToken<I, O>,
    input: I,
    final: (input: I) => Promise<O>,
  ): Promise<O>;
  dispatch<T>(token: SerialToken<T>, payload: T): Promise<void>;
  dispatch<T>(token: GuardToken<T>, payload: T): Promise<GuardDeny | undefined>;
  dispatch<T>(token: ParallelToken<T>, payload: T): Promise<void>;

  createChain<I, O>(final: (input: I) => Promise<O>): Chain<I, O>;
  onChain<I, O>(chain: Chain<I, O>, middleware: ChainMiddleware<I, O>): Disposer;

  effect(disposer: Disposer): void;
  dispose(): Promise<void>;

  scope(filter: ScopeFilter): Context;
}

export interface Plugin {
  readonly name: string;
  readonly inject?: readonly string[];
  readonly softInject?: readonly string[];
  apply(ctx: Context, capabilities?: PluginCapabilities): Disposer | void | Promise<Disposer | void>;
}

export interface PluginCapabilities {
  use<T = unknown>(name: string): T;
  tryUse<T = unknown>(name: string): T | undefined;
  waitFor<T = unknown>(name: string): Promise<T>;
  provide<T = unknown>(name: string, impl: T): Disposer;
  on(name: string, listener: (payload: unknown) => void): Disposer;
  emit(name: string, payload: unknown): void;
}

export interface ContextOptions {
  onListenerError?: (error: unknown, token: { readonly name: string }) => void;
}
