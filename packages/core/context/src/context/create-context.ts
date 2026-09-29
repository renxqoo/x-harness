import { deepFreeze, shellFreeze } from "./freeze.ts";
import { stderrLine } from "../stderr-line.ts";
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
  GuardToken,
  ParallelToken,
  ScopeFilter,
  SerialToken,
  ServiceToken,
  WaterfallToken,
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

interface ServiceWaiter {
  readonly token: ServiceToken<unknown>;
  readonly layer: Layer;
  resolve(impl: unknown): void;
  reject(error: Error): void;
}

function defaultSink(error: unknown, token: { readonly name: string }): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  stderrLine(`[x-harness] listener error on "${token.name}": ${detail}`);
}

function applyEmitFreeze(token: EventToken<unknown>, payload: unknown): unknown {
  if (token.freeze === "deep") return deepFreeze(payload);
  if (token.freeze === "shell") return shellFreeze(payload);
  return payload;
}

function assertLive(layer: Layer, verb: string): void {
  if (layer.state !== "live") {
    throw new Error(
      `context layer (agentId: ${layer.filter?.agentId ?? "root"}) is ${layer.state}; ${verb} is rejected after dispose`,
    );
  }
}

function assertChainLive(layer: Layer, verb: string): void {
  for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.state !== "live") {
      throw new Error(
        `context layer (agentId: ${cursor.filter?.agentId ?? "root"}) is ${cursor.state}; ${verb} is rejected while a scope chain layer is disposing`,
      );
    }
  }
}

function chainSet(layer: Layer): Set<Layer> {
  const set = new Set<Layer>();
  for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
    set.add(cursor);
  }
  return set;
}

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

function assertEventTokenShape(token: AnyToken): void {
  if (token.kind !== "event" || typeof token.mode !== "string" || typeof token.freeze !== "string") {
    throw new Error(`invalid event token shape for "${String(token?.name ?? "?")}"`);
  }
}

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

interface WaterfallRun<I, O> {
  readonly name: string;
  readonly middlewares: readonly ChainMiddleware<I, O>[];
  readonly final: (input: I) => Promise<O>;
}

async function runWaterfall<I, O>(run: WaterfallRun<I, O>, index: number, input: I): Promise<O> {
  const middleware = run.middlewares[index];
  if (middleware === undefined) return run.final(input);
  let inFlight = false;
  let called = false;
  let closed = false;
  const next = (arg: I): Promise<O> => {
    if (closed) {
      throw new Error(`waterfall "${run.name}": next() called after middleware returned`);
    }
    if (inFlight) {
      throw new Error(`waterfall "${run.name}": concurrent next() call`);
    }
    called = true;
    inFlight = true;
    const pending = runWaterfall(run, index + 1, deepFreeze(arg));
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
    throw new Error(`waterfall "${run.name}": middleware returned without calling next()`);
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
  const services = new Map<AnyToken, Map<Layer, unknown>>();
  const listeners = new Map<AnyToken, ListenerEntry[]>();
  const chains = new WeakMap<Chain<unknown, unknown>, ChainRegistry>();
  const waiters = new Set<ServiceWaiter>();

  function findVisibleEntry<T>(token: ServiceToken<T>, layer: Layer): { impl: T } | undefined {
    const byLayer = services.get(token);
    if (byLayer === undefined) return undefined;
    for (let cursor: Layer | undefined = layer; cursor !== undefined; cursor = cursor.parent) {
      if (byLayer.has(cursor)) return { impl: byLayer.get(cursor) as T };
    }
    return undefined;
  }

  function settleWaiters(token: ServiceToken<unknown>, providing: Layer): void {
    const pending = Array.from(waiters);
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
    }
  }

  function emitFrom(layer: Layer, token: EventToken<unknown>, payload: unknown): void {
    assertEventTokenShape(token);
    const registered = listeners.get(token);
    if (registered === undefined || registered.length === 0) return;
    const frozen = applyEmitFreeze(token, payload);
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
        settleWaiters(token, layer);
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
            const middlewares = registry.entries.map(
              (entry) => entry.middleware as ChainMiddleware<I, O>,
            );
            return runWaterfall({ name: "chain", middlewares, final }, 0, deepFreeze(input));
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
        if (layer.state !== "live") return;
        layer.state = "disposing";
        emitFrom(layer, contextDisposing, {});
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
        const parked = Array.from(waiters);
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
        const childContext = makeContext(child);
        layer.effects.push(() => childContext.dispose());
        return childContext;
      },
    };

    function dispatchWaterfall(
      token: WaterfallToken<unknown, unknown>,
      input: unknown,
      final: ((input: unknown) => Promise<unknown>) | undefined,
    ): Promise<unknown> {
      if (typeof final !== "function") {
        throw new Error(`waterfall "${token.name}" dispatch requires a final`);
      }
      const middlewares = collectListeners(
        layer,
        token,
        "waterfall",
      ) as ChainMiddleware<unknown, unknown>[];
      return runWaterfall({ name: token.name, middlewares, final }, 0, deepFreeze(input));
    }

    async function dispatchParallel(
      token: ParallelToken<unknown>,
      payload: unknown,
    ): Promise<unknown> {
      const registered = collectListeners(layer, token, "parallel") as ((
        payload: unknown,
      ) => unknown)[];
      const frozen = deepFreeze(payload);
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

    async function dispatchSerial(token: SerialToken<unknown>, payload: unknown): Promise<unknown> {
      const registered = collectListeners(layer, token, "serial") as ((
        payload: unknown,
      ) => Promise<void> | void)[];
      const frozen = deepFreeze(payload);
      for (const listener of registered) {
        try {
          await listener(frozen);
        } catch (error) {
          reportListenerError(error, token);
        }
      }
      return undefined;
    }

    async function dispatchGuard(token: GuardToken<unknown>, payload: unknown): Promise<unknown> {
      const registered = collectListeners(layer, token, "guard") as ((
        payload: unknown,
      ) => GuardDeny | void | Promise<GuardDeny | void>)[];
      const frozen = deepFreeze(payload);
      let firstDeny: GuardDeny | undefined;
      for (const listener of registered) {
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

    async function dispatchImpl(
      token: AnyToken,
      payloadOrInput: unknown,
      final?: (input: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      assertChainLive(layer, "dispatch");
      if (token.kind === "waterfall") return dispatchWaterfall(token, payloadOrInput, final);
      if (token.kind === "parallel") return dispatchParallel(token, payloadOrInput);
      if (token.kind === "serial") return dispatchSerial(token, payloadOrInput);
      if (token.kind === "guard") return dispatchGuard(token, payloadOrInput);
      throw new Error(
        `dispatch expects a waterfall/serial/guard token, got kind "${String(token?.kind)}" for "${String(token?.name ?? "?")}"`,
      );
    }

    return { ...context, dispatch: dispatchImpl as Context["dispatch"] };
  }

  return makeContext(root);
}
