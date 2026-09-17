// Context 原语类型面（docs/CONTEXT.md §1–§5、§2.1）。
// 两种名字：服务 token 与事件 token，都注册即类型（C1）；派发模式编码在 token 里。

/** 注册即回卷句柄；dispose 串行逆序执行（§4） */
export type Disposer = () => void | Promise<void>;

export interface ServiceToken<T> {
  readonly kind: "service";
  readonly name: string;
  /** 幻影类型位：仅用于 use/provide 的泛型推断 */
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

export type AnyToken =
  | ServiceToken<unknown>
  | EventToken<unknown>
  | WaterfallToken<unknown, unknown>
  | SerialToken<unknown>
  | GuardToken<unknown>;

/** guard 的唯一输出形态：只能否决，无 allow 可翻回（§2.2） */
export interface GuardDeny {
  readonly kind: "deny";
  readonly reason: string;
}

/** waterfall 监听器与匿名链中间件的共同形状：洋葱包裹，必须调 next（I2） */
export type ChainMiddleware<I, O> = (
  input: I,
  next: (input: I) => Promise<O>,
) => Promise<O>;

/** 匿名链：无全局名不进词表，owner 持有并经服务共享（§6.2） */
export interface Chain<I, O> {
  dispatch(input: I): Promise<O>;
}

export interface ChainEntry<I, O> {
  readonly layer: unknown;
  readonly middleware: ChainMiddleware<I, O>;
}

/** scope 过滤键：本轮按 { agentId } 落地（IMPL 裁决 1），扩展留后 */
export interface ScopeFilter {
  readonly agentId: string;
}

export interface Context {
  // —— 服务面（§1）——
  provide<T>(token: ServiceToken<T>, impl: T): Disposer;
  use<T>(token: ServiceToken<T>): T;
  tryUse<T>(token: ServiceToken<T>): T | undefined;

  // —— 事件面（§2）——
  on<T>(token: EventToken<T>, listener: (payload: T) => void): Disposer;
  on<I, O>(token: WaterfallToken<I, O>, middleware: ChainMiddleware<I, O>): Disposer;
  // serial 监听器声明为纯 void 返回：同步（任意返回值）与 async（Promise）都经 void 赋值规则匹配
  on<T>(token: SerialToken<T>, listener: (payload: T) => void): Disposer;
  on<T>(
    token: GuardToken<T>,
    listener: (payload: T) => GuardDeny | void | Promise<GuardDeny | void>,
  ): Disposer;

  emit<T>(token: EventToken<T>, payload: T): void;

  dispatch<I, O>(
    token: WaterfallToken<I, O>,
    input: I,
    final: (input: I) => Promise<O>,
  ): Promise<O>;
  dispatch<T>(token: SerialToken<T>, payload: T): Promise<void>;
  dispatch<T>(token: GuardToken<T>, payload: T): Promise<GuardDeny | undefined>;

  createChain<I, O>(final: (input: I) => Promise<O>): Chain<I, O>;
  onChain<I, O>(chain: Chain<I, O>, middleware: ChainMiddleware<I, O>): Disposer;

  // —— 生命周期（§3–§4）——
  effect(disposer: Disposer): void;
  dispose(): Promise<void>;

  scope(filter: ScopeFilter): Context;
}

export interface Plugin {
  readonly name: string;
  /** 依赖的插件名——加载序约束（topo）；引用不存在的名字 = 装配期 throw（IMPL 裁决 5） */
  readonly inject?: readonly string[];
  apply(ctx: Context): Disposer | void | Promise<Disposer | void>;
}

/** 监听器错误归宿：注入式 sink 而非 logger 服务（C5：自举序） */
export interface ContextOptions {
  onListenerError?: (error: unknown, token: { readonly name: string }) => void;
}
