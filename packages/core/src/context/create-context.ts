// Context 实现（docs/CONTEXT.md §1–§4、§6.2）：服务注册表 + 四模式总线 + scope 层链 + effect 账本。
// 结构：注册表按 token 对象为键、条目携带层标记——scope 是过滤器不是副本（C2）。
//   - 监听器：链上并集、root→leaf 次序、不遮蔽（多播语义）；
//   - 服务：nearest-first 遮蔽（单播语义）；
//   - emit 定向 = chain-up：本层 + 祖先链可见，兄弟不可见（C3）——service/provided 亦然（提供层 chain-up）；
//   - 一切注册的 disposer 自动入层 effect 账本（I1）：手动调用与层回卷都幂等，且自清理
//     （手动退订后账本不再持有尸体闭包——对抗审查 #5 修复）。

import { deepFreeze, shellFreeze } from "./freeze.ts";
import { contextDisposing, serviceProvided } from "./vocab.ts";
import type {
  AnyToken,
  Chain,
  ChainMiddleware,
  Context,
  ContextOptions,
  Disposer,
  EventToken,
  GuardDeny,
  ScopeFilter,
  ServiceToken,
} from "./types.ts";

type LayerState = "live" | "disposing" | "disposed";
type ListenerMode = "emit" | "waterfall" | "serial" | "guard" | "parallel";

interface Layer {
  readonly parent: Layer | undefined;
  readonly depth: number;
  readonly filter: ScopeFilter | undefined;
  readonly effects: Disposer[];
  state: LayerState;
}

interface ListenerEntry {
  readonly layer: Layer;
  readonly mode: ListenerMode;
  readonly fn: unknown;
}

interface ChainRegistry {
  readonly entries: { layer: Layer; middleware: unknown }[];
}

/** waitFor 的停靠位：提供层出现在等待者可见链上时解析 */
interface ServiceWaiter {
  readonly token: ServiceToken<unknown>;
  readonly layer: Layer;
  resolve(impl: unknown): void;
  reject(error: Error): void;
}

function defaultSink(error: unknown, token: { readonly name: string }): void {
  console.error(`[x-harness] listener error on "${token.name}"`, error);
}

function assertLive(layer: Layer, verb: string): void {
  if (layer.state !== "live") {
    throw new Error(
      `context layer (agentId: ${layer.filter?.agentId ?? "root"}) is ${layer.state}; ${verb} is rejected after dispose`,
    );
  }
}

/** 整条祖先链全 live（dispatch 的 unwind 边界：父层回卷中途的子层派发同属半拆态——§4） */
function assertChainLive(layer: Layer, verb: string): void {
  for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.state !== "live") {
      throw new Error(
        `context layer (agentId: ${cursor.filter?.agentId ?? "root"}) is ${cursor.state}; ${verb} is rejected while a scope chain layer is disposing`,
      );
    }
  }
}

/** 本层 + 全部祖先的集合（chain-up 可见集，C3） */
function chainSet(layer: Layer): Set<Layer> {
  const set = new Set<Layer>();
  for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
    set.add(cursor);
  }
  return set;
}

/** 层序插入（§10.1 性能债修复：数组恒按 root→leaf 层序，派发免排序）。
 *  默认：插到「深度 ≤ 自身的最后一个条目」之后 = 本层段尾（保注册序）；
 *  prepend：插到「深度 ≥ 自身的第一个条目」之前 = 本层段头（层序仍优先——root 恒先于子层）。 */
function insertByLayerDepth<T extends { readonly layer: Layer }>(
  entries: T[],
  entry: T,
  prepend = false,
): void {
  if (prepend) {
    let at = 0;
    while (at < entries.length) {
      const ahead = entries[at];
      if (ahead === undefined || ahead.layer.depth >= entry.layer.depth) break;
      at += 1;
    }
    entries.splice(at, 0, entry);
    return;
  }
  let at = entries.length;
  while (at > 0) {
    const previous = entries[at - 1];
    if (previous === undefined || previous.layer.depth <= entry.layer.depth) break;
    at -= 1;
  }
  entries.splice(at, 0, entry);
}

/** 运行时 token 形状校验：缺 mode/freeze 的伪造对象拒收（对抗审查 #7 修复） */
function assertEventTokenShape(token: AnyToken): void {
  if (token.kind !== "event" || typeof token.mode !== "string" || typeof token.freeze !== "string") {
    throw new Error(`invalid event token shape for "${String(token?.name ?? "?")}"`);
  }
}

/** 注册动作入账：disposer 自清理（手动退订同步移出账本，层回卷幂等）+ 注册表空时删除键 */
function registerEffect(layer: Layer, teardown: () => void, cleanup?: () => void): Disposer {
  const disposer: Disposer = () => {
    const at = layer.effects.indexOf(disposer);
    if (at >= 0) layer.effects.splice(at, 1);
    teardown();
    cleanup?.();
  };
  layer.effects.push(disposer);
  return disposer;
}

/** waterfall 合成：next 至少一次（返回未调 = throw）、串行重调合法、并发 = throw（I2）；
 *  中间件返回后 next 失效（僵尸围栏——macrotask 形态；microtask 极限窗口见 §10 已知限制）。 */
async function runWaterfall<I, O>(
  name: string,
  middlewares: readonly ChainMiddleware<I, O>[],
  index: number,
  input: I,
  final: (input: I) => Promise<O>,
): Promise<O> {
  const middleware = middlewares[index];
  if (middleware === undefined) return final(input);
  let inFlight = false;
  let called = false;
  let closed = false;
  const next = (arg: I): Promise<O> => {
    if (closed) {
      throw new Error(`waterfall "${name}": next() called after middleware returned`);
    }
    if (inFlight) {
      throw new Error(`waterfall "${name}": concurrent next() call`);
    }
    called = true;
    inFlight = true;
    const pending = runWaterfall(name, middlewares, index + 1, deepFreeze(arg), final);
    const settle = (): void => {
      inFlight = false;
    };
    pending.then(settle, settle);
    return pending;
  };
  let output: O;
  try {
    output = await middleware(input, next);
  } finally {
    closed = true;
  }
  if (!called) {
    throw new Error(`waterfall "${name}": middleware returned without calling next()`);
  }
  return output;
}

export function createContext(options: ContextOptions = {}): Context {
  const sink = options.onListenerError ?? defaultSink;
  const root: Layer = {
    parent: undefined,
    depth: 0,
    filter: undefined,
    effects: [],
    state: "live",
  };
  // token 对象为键：同名不同 token 互不可见（跨插件隔离域，tokens.ts 注释同口径）
  const services = new Map<AnyToken, Map<Layer, unknown>>();
  const listeners = new Map<AnyToken, ListenerEntry[]>();
  const chains = new WeakMap<Chain<unknown, unknown>, ChainRegistry>();
  const waiters = new Set<ServiceWaiter>();

  /** use/tryUse/waitFor 共用：沿层链 nearest-first 查找。返回命中壳而非裸值——
   *  「找到 undefined」≠「没找到」（审查 #8：provide(undefined) 遮蔽不穿透） */
  function findVisibleEntry<T>(token: ServiceToken<T>, layer: Layer): { impl: T } | undefined {
    const byLayer = services.get(token);
    if (byLayer === undefined) return undefined;
    for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
      if (byLayer.has(cursor)) return { impl: byLayer.get(cursor) as T };
    }
    return undefined;
  }

  /** provide 落账后：解析停靠中且可见层命中的等待者 */
  function settleWaiters(token: ServiceToken<unknown>, providing: Layer): void {
    const pending = Array.from(waiters); // 快照：解析路径会从 Set 删除成员
    for (const waiter of pending) {
      if (waiter.token !== token) continue;
      if (!chainSet(waiter.layer).has(providing)) continue;
      const hit = findVisibleEntry(waiter.token, waiter.layer);
      if (hit === undefined) continue;
      waiters.delete(waiter);
      waiter.resolve(hit.impl);
    }
  }

  function reportListenerError(error: unknown, token: AnyToken): void {
    try {
      sink(error, token);
    } catch {
      // sink 自身失败静默：错误隔离链不得因观察者再失败而中断（§2.4）
    }
  }

  function emitFrom(layer: Layer, token: EventToken<unknown>, payload: unknown): void {
    assertEventTokenShape(token);
    const registered = listeners.get(token);
    if (registered === undefined || registered.length === 0) return;
    const frozen =
      token.freeze === "deep" ? deepFreeze(payload)
      : token.freeze === "shell" ? shellFreeze(payload)
      : payload;
    const visible = registered.filter((entry) => chainSet(layer).has(entry.layer));
    for (const entry of visible) {
      try {
        const returned = (entry.fn as (payload: unknown) => unknown)(frozen);
        if (
          returned !== null &&
          typeof returned === "object" &&
          typeof (returned as Promise<unknown>).then === "function" &&
          typeof (returned as Promise<unknown>).catch === "function"
        ) {
          (returned as Promise<unknown>).catch((error: unknown) => {
            reportListenerError(error, token);
          });
        }
      } catch (error) {
        reportListenerError(error, token);
      }
    }
  }

  function collectListeners(layer: Layer, token: AnyToken, mode: ListenerMode): unknown[] {
    const registered = listeners.get(token);
    if (registered === undefined) return [];
    const visible = chainSet(layer);
    return registered
      .filter((entry) => entry.mode === mode && visible.has(entry.layer))
      .map((entry) => entry.fn);
  }

  function makeContext(layer: Layer): Context {
    const context = {
      provide<T>(token: Parameters<Context["provide"]>[0], impl: T): Disposer {
        assertLive(layer, "provide");
        if (token.kind !== "service" || typeof token.name !== "string") {
          throw new Error(`provide expects a service token, got kind "${String(token?.kind)}"`);
        }
        let byLayer = services.get(token);
        if (byLayer === undefined) {
          byLayer = new Map();
          services.set(token, byLayer);
        }
        if (byLayer.has(layer)) {
          throw new Error(`service "${token.name}" already provided on this layer`);
        }
        byLayer.set(layer, impl);
        settleWaiters(token, layer); // waitFor 停靠者先于事件广播解析（解析即事实，观察是旁路）
        // 先入账后广播：service/provided 监听者内触发 dispose 时本注册可被回卷（对抗审查 #6 修复）
        const disposer = registerEffect(
          layer,
          () => {
            if (byLayer.get(layer) === impl) byLayer.delete(layer);
          },
          () => {
            if (byLayer !== undefined && byLayer.size === 0) services.delete(token);
          },
        );
        emitFrom(layer, serviceProvided, { service: token.name });
        return disposer;
      },

      use<T>(token: Parameters<Context["use"]>[0]): T {
        const hit = findVisibleEntry(token as ServiceToken<T>, layer);
        if (hit !== undefined) return hit.impl;
        throw new Error(
          `service "${token.name}" not provided (searched scope chain up to root)`,
        );
      },

      tryUse<T>(token: Parameters<Context["tryUse"]>[0]): T | undefined {
        return findVisibleEntry(token as ServiceToken<T>, layer)?.impl;
      },

      waitFor<T>(token: Parameters<Context["waitFor"]>[0]): Promise<T> {
        if (layer.state !== "live") {
          return Promise.reject(
            new Error(
              `cannot wait for service "${token.name}" on a ${layer.state} context layer`,
            ),
          );
        }
        const ready = findVisibleEntry(token as ServiceToken<T>, layer);
        if (ready !== undefined) return Promise.resolve(ready.impl);
        return new Promise<T>((resolve, reject) => {
          const waiter: ServiceWaiter = {
            token: token as ServiceToken<unknown>,
            layer,
            resolve: (impl) => resolve(impl as T),
            reject,
          };
          waiters.add(waiter);
        });
      },

      on(token: AnyToken, fn: unknown, registerOpts?: { readonly prepend?: boolean }): Disposer {
        assertLive(layer, "on");
        if (token.kind === "service" || typeof token.mode !== "string") {
          throw new Error(`on expects an event-like token, got "${String(token?.name ?? "?")}"`);
        }
        const entry: ListenerEntry = { layer, mode: token.mode, fn };
        const registered = listeners.get(token) ?? [];
        insertByLayerDepth(registered, entry, registerOpts?.prepend === true);
        listeners.set(token, registered);
        return registerEffect(
          layer,
          () => {
            const list = listeners.get(token);
            if (list === undefined) return;
            const at = list.indexOf(entry);
            if (at >= 0) list.splice(at, 1);
          },
          () => {
            const list = listeners.get(token);
            if (list !== undefined && list.length === 0) listeners.delete(token);
          },
        );
      },

      emit<T>(token: EventToken<T>, payload: T): void {
        if (token.kind !== "event") {
          throw new Error(
            `emit expects an event token, got kind "${String(token?.kind)}" for "${String(token?.name ?? "?")}"`,
          );
        }
        emitFrom(layer, token, payload);
      },

      createChain<I, O>(final: (input: I) => Promise<O>): Chain<I, O> {
        assertLive(layer, "createChain");
        const registry: ChainRegistry = { entries: [] };
        const chain = {
          dispatch(input: I): Promise<O> {
            // 匿名链无层上下文：owner 主动共享给谁谁就能拦截——全部注册可见（IMPL 裁决 6）
            const middlewares = registry.entries.map(
              (entry) => entry.middleware as ChainMiddleware<I, O>,
            );
            return runWaterfall("chain", middlewares, 0, deepFreeze(input), final);
          },
        } as Chain<I, O>;
        chains.set(chain as Chain<unknown, unknown>, registry);
        return chain;
      },

      onChain<I, O>(
        chain: Chain<I, O>,
        middleware: ChainMiddleware<I, O>,
        registerOpts?: { readonly prepend?: boolean },
      ): Disposer {
        assertLive(layer, "onChain");
        const registry = chains.get(chain as Chain<unknown, unknown>);
        if (registry === undefined) {
          throw new Error("onChain expects a chain created by createChain");
        }
        const entry = { layer, middleware };
        insertByLayerDepth(registry.entries, entry, registerOpts?.prepend === true);
        // 层归属消费方：注册入消费方层账本，dispose 时随层回卷（C10）
        return registerEffect(layer, () => {
          const at = registry.entries.indexOf(entry);
          if (at >= 0) registry.entries.splice(at, 1);
        });
      },

      effect(disposer: Disposer): void {
        assertLive(layer, "effect");
        layer.effects.push(disposer);
      },

      async dispose(): Promise<void> {
        if (layer.state !== "live") return; // 幂等（IMPL 裁决 4）
        layer.state = "disposing";
        emitFrom(layer, contextDisposing, {});
        // 回卷容错：单个 disposer 抛错不中止回卷（I1 优先），全部完成后聚合上抛（#1 修复）
        const failures: unknown[] = [];
        for (let index = layer.effects.length - 1; index >= 0; index -= 1) {
          const unwind = layer.effects[index];
          if (unwind === undefined) continue;
          try {
            await unwind();
          } catch (error) {
            failures.push(error);
          }
        }
        layer.effects.length = 0;
        layer.state = "disposed";
        const parked = Array.from(waiters); // 快照：reject 路径会从 Set 删除成员
        for (const waiter of parked) {
          if (waiter.layer !== layer) continue;
          waiters.delete(waiter);
          waiter.reject(
            new Error(`service "${waiter.token.name}" never arrived: layer disposed while waiting`),
          );
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "dispose unwind failures");
      },

      scope(filter: ScopeFilter): Context {
        assertLive(layer, "scope");
        const child: Layer = {
          parent: layer,
          depth: layer.depth + 1,
          filter,
          effects: [],
          state: "live",
        };
        // scope 创建本身在父层登记 effect：父回卷自动收编未显式 dispose 的子层（§3）
        const childContext = makeContext(child);
        layer.effects.push(() => childContext.dispose());
        return childContext;
      },
    };

    // dispatch 三分支（waterfall/serial/guard）——按 token.kind 路由后 cast 回重载面
    async function dispatchImpl(
      token: AnyToken,
      payloadOrInput: unknown,
      final?: (input: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      assertChainLive(layer, "dispatch");
      if (token.kind === "waterfall") {
        if (typeof final !== "function") {
          throw new Error(`waterfall "${token.name}" dispatch requires a final`);
        }
        const middlewares = collectListeners(
          layer,
          token,
          "waterfall",
        ) as ChainMiddleware<unknown, unknown>[];
        return runWaterfall(token.name, middlewares, 0, deepFreeze(payloadOrInput), final);
      }
      if (token.kind === "parallel") {
        const registered = collectListeners(layer, token, "parallel") as ((
          payload: unknown,
        ) => unknown)[];
        const frozen = deepFreeze(payloadOrInput);
        const results = await Promise.allSettled(registered.map((listener) => listener(frozen)));
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected.length === 1) throw rejected[0]?.reason;
        if (rejected.length > 1) {
          throw new AggregateError(
            rejected.map((result) => result.reason),
            "parallel dispatch failures",
          );
        }
        return undefined;
      }
      if (token.kind === "serial") {
        const registered = collectListeners(layer, token, "serial") as ((
          payload: unknown,
        ) => Promise<void> | void)[];
        const frozen = deepFreeze(payloadOrInput);
        for (const listener of registered) {
          try {
            await listener(frozen);
          } catch (error) {
            reportListenerError(error, token);
          }
        }
        return undefined;
      }
      if (token.kind === "guard") {
        const registered = collectListeners(layer, token, "guard") as ((
          payload: unknown,
        ) => GuardDeny | void | Promise<GuardDeny | void>)[];
        const frozen = deepFreeze(payloadOrInput);
        let firstDeny: GuardDeny | undefined;
        for (const listener of registered) {
          // 全部执行不短路：deny 只决定结果（首个按注册序胜出），坏守卫按弃权计（C7）；
          // 返回值形状校验：非 deny 形状按弃权（对抗审查 #7）
          try {
            const verdict = await listener(frozen);
            if (
              firstDeny === undefined &&
              verdict !== null &&
              typeof verdict === "object" &&
              (verdict as GuardDeny).kind === "deny"
            ) {
              firstDeny = verdict as GuardDeny;
            }
          } catch (error) {
            reportListenerError(error, token);
          }
        }
        return firstDeny;
      }
      throw new Error(
        `dispatch expects a waterfall/serial/guard token, got kind "${String(token?.kind)}" for "${String(token?.name ?? "?")}"`,
      );
    }

    return { ...context, dispatch: dispatchImpl as Context["dispatch"] };
  }

  return makeContext(root);
}
