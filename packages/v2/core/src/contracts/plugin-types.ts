import type {
  CallOptions, ChainToken, CleanupInvocation, Context, DefinitionRef, Disposer, EventToken, GuardDecision,
  GuardToken, Invocation, MaybePromise, Next, RegistrationOptions, Result, SameSignature, ServiceToken, TaskHandle,
} from "./types";

export type TokenMap = Readonly<Record<string, DefinitionRef>>;
export interface PluginManifest {
  readonly requires?: TokenMap;
  readonly provides?: TokenMap;
  readonly optional?: TokenMap;
}
type IsUnion<T, U = T> = (T extends unknown ? [U] extends [T] ? false : true : never) extends false ? false : true;
type ConsistentToken<T> = IsUnion<T> extends true ? never : IsUnion<ServiceOf<T>> extends true ? never : T extends ServiceToken<infer S> ? IsUnion<S> extends true ? never : T : T;
type ConsistentTokens<T extends TokenMap, N extends keyof T = keyof T> = {
  readonly [K in N as [ConsistentToken<T[K]>] extends [never] ? never : K]: T[K];
};
type Tokens<M extends PluginManifest, K extends keyof PluginManifest> = M[K] extends TokenMap ? ConsistentTokens<M[K]> : Record<never, never>;
type Available<M extends PluginManifest> = Tokens<M, "requires"> & Tokens<M, "provides"> & Tokens<M, "optional">;
type ServiceFunctions<S, N extends keyof S = keyof S> = {
  readonly [K in N]: S[K] extends (...input: infer I) => infer R ? (...input: I) => R : never;
} & {};
type ServiceOf<T> = T extends ServiceToken<infer S> ? S extends unknown ? ServiceFunctions<S> : never : never;
export type Dependencies<D extends TokenMap> = {
  readonly [K in keyof D as D[K] extends { readonly kind: "service" } ? K : never]: ServiceOf<D[K]>;
} & {};
export type PluginDependencies<M extends PluginManifest = Record<never, never>> = Dependencies<Tokens<M, "requires">> & Partial<Dependencies<Tokens<M, "optional">>>;

export type PluginResource<T, E, M extends PluginManifest = Record<never, never>> = [M] extends [unknown] ? {
  readonly open: (call: PluginInvocation<M>) => MaybePromise<Result<T, E>>;
  readonly close: (value: T, cleanup: CleanupInvocation) => MaybePromise<Result<void>>;
} : never;

export type PluginTask<T, E, M extends PluginManifest = Record<never, never>> = CallOptions & {
  readonly label: string;
  readonly run: (call: PluginInvocation<M>) => MaybePromise<Result<T, E>>;
};

export type PluginInvocation<M extends PluginManifest = Record<never, never>> = Omit<Invocation, "deps" | "resource" | "spawn" | "dispatch"> & {
  readonly deps: PluginDependencies<M>;
  readonly dispatch: DispatchCall<M>;
  readonly resource: <T, E = never>(spec: PluginResource<T, E, M>) => Promise<Result<T, E>>;
  readonly spawn: <T, E = never>(spec: PluginTask<T, E, M>) => Result<TaskHandle<T, E>>;
};

type Implementation<T, M extends PluginManifest> =
  T extends ServiceToken<infer S> ? {
    readonly [K in keyof S]: S[K] extends (input: infer I) => Promise<infer R>
      ? (input: I, call: PluginInvocation<M>) => Promise<R> : never;
  } & {} : T extends ChainToken<infer I, infer R, infer E>
    ? (input: I, call: PluginInvocation<M>) => MaybePromise<Result<R, E>>
    : never;

export type PluginImplementations<M extends PluginManifest = Record<never, never>> = [M] extends [unknown] ? {
  readonly [K in keyof Tokens<M, "provides"> as Tokens<M, "provides">[K] extends { readonly kind: "service" } ? K : never]: Implementation<Tokens<M, "provides">[K], M>;
} : never;

type Handler<T, M extends PluginManifest> =
  T extends ChainToken<infer I, infer R, infer E> ? (input: I, next: Next<I, R, E>, call: PluginInvocation<M>) => MaybePromise<Result<R, E>>
    : T extends GuardToken<infer I> ? (input: I, call: PluginInvocation<M>) => MaybePromise<Result<GuardDecision>>
      : T extends EventToken<infer I> ? (input: I, origin: import("./types").EventOrigin, call: PluginInvocation<M>) => MaybePromise<void> : never;

type Dispatch<T> = T extends ChainToken<infer I, infer R, infer E> ? [input: I, result: Result<R, E>]
  : T extends GuardToken<infer I> ? [input: I, result: Result<GuardDecision>] : never;
type Keys<T extends TokenMap, Kind extends DefinitionRef["kind"]> = {
  [K in keyof T]: T[K] extends { readonly kind: Kind } ? K : never;
}[keyof T];
type EquivalentKeys<T extends TokenMap, Key extends keyof T, N extends keyof T = keyof T> = {
  [K in N]: SameSignature<T[K], T[Key]> extends true ? K : never;
}[N];
type Overloads<F, R> = [F] extends [never] ? (name: never, ...input: never[]) => R : (F extends unknown ? (signature: F) => void : never) extends (signature: infer I) => void ? I : never;
type DispatchCall<M extends PluginManifest> = Overloads<{
  [K in Keys<Available<M>, "chain" | "guard">]: (name: EquivalentKeys<Available<M>, K>, input: Dispatch<Available<M>[K]>[0], options?: CallOptions) => Promise<Dispatch<Available<M>[K]>[1]>;
}[Keys<Available<M>, "chain" | "guard">], Promise<Result<unknown, unknown>>>;
type HandlerCall<M extends PluginManifest, Kind extends "chain" | "guard" | "event"> = Overloads<{
  [K in Keys<Available<M>, Kind>]: (name: EquivalentKeys<Available<M>, K>, handler: Handler<Available<M>[K], M>) => Result<Disposer>;
}[Keys<Available<M>, Kind>], Result<Disposer>>;
type TerminalCall<M extends PluginManifest> = Overloads<{
  [K in Keys<Tokens<M, "provides">, "chain">]: (name: EquivalentKeys<Tokens<M, "provides">, K>, terminal: Implementation<Tokens<M, "provides">[K], M>, options?: RegistrationOptions) => Result<Disposer>;
}[Keys<Tokens<M, "provides">, "chain">], Result<Disposer>>;
type EmitCall<M extends PluginManifest> = Overloads<{
  [K in Keys<Tokens<M, "provides">, "event">]: (name: EquivalentKeys<Tokens<M, "provides">, K>, payload: Tokens<M, "provides">[K] extends EventToken<infer I> ? I : never) => Result<import("./types").EmitReceipt>;
}[Keys<Tokens<M, "provides">, "event">], Result<import("./types").EmitReceipt>>;

export type PluginContext<M extends PluginManifest = Record<never, never>> = Omit<
  Context, "deps" | "service" | "handle" | "register" | "use" | "on" | "middleware" | "guard" | "dispatch" | "emit" | "resource" | "startTask"
> & {
  readonly deps: PluginDependencies<M>;
  readonly service: <const I extends PluginImplementations<M>>(implementations: I & Record<Exclude<keyof I, keyof PluginImplementations<M>>, never>, options?: RegistrationOptions) => Result<{ readonly [K in keyof Tokens<M, "provides"> as Tokens<M, "provides">[K] extends { readonly kind: "service" } ? K : never]: Disposer }>;
  readonly handle: TerminalCall<M>;
  readonly middleware: HandlerCall<M, "chain">;
  readonly guard: HandlerCall<M, "guard">;
  readonly on: HandlerCall<M, "event">;
  readonly dispatch: DispatchCall<M>;
  readonly emit: EmitCall<M>;
  readonly resource: <T, E = never>(spec: PluginResource<T, E, M>) => Promise<Result<T, E>>;
  readonly startTask: <T, E = never>(spec: PluginTask<T, E, M>) => Result<TaskHandle<T, E>>;
};

type ManifestKeys<M> = M extends unknown ? keyof M : never;
export type PluginSpec<M extends PluginManifest = Record<never, never>> = { readonly [K in keyof M]: M[K] } & {
  readonly name: string;
  readonly setup: (ctx: PluginContext<NoInfer<M>>) => MaybePromise<Result<unknown, unknown>>;
} & Record<Exclude<ManifestKeys<M>, keyof PluginManifest | "name" | "setup">, never>;

