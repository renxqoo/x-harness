// process 模式错误路由 + 注册落位（docs/PLUGIN-MANAGER.md 裁决 3 / 裁决 9）：
//   错误路由——emit 监听器：catch → 归属记录 + 信封，不 rethrow（与内核 I3 隔离一致，但带归属）；
//              waterfall/serial/guard/parallel 中间件：catch → 归属记录 → rethrow（关键路径不可吞）。
//   注册落位——provide/on 落平台 root（可见性向上：chain-up 决定子层注册对平台不可见），
//              disposer 链进插件 scope（回卷向下：scope dispose 收编 root 注册）。

import type { AnyToken, Chain, ChainMiddleware, Context, Disposer, EventToken, Plugin, ScopeFilter, ServiceToken } from "@x-harness/core";
import { pluginEvent } from "@x-harness/core";

/** thenable 判定（#18）：then+catch 双检——仅有 then 的普通对象不是可等待的 Promise */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Promise<unknown>).then === "function" &&
    typeof (value as Promise<unknown>).catch === "function"
  );
}

export type ErrorSink = (where: string, message: string) => void;

/** 错误路由依赖：sink（归属记录）、root（注册落位层）、onToken（token 注册表收集） */
export interface ErrorRoutingDeps {
  readonly sink: ErrorSink;
  readonly root: Context;
  readonly onToken?: (token: AnyToken) => void;
}

export function wrapPluginForErrorRouting(plugin: Plugin, deps: ErrorRoutingDeps): Plugin {
  return {
    name: plugin.name, // inject 刻意丢弃：跨插件依赖语义归 plugin-manager（loadPlugins 只认同批）
    apply: (scope: Context) => {
      const wrapped = wrapContext(scope, { ...deps, pluginName: plugin.name });
      return plugin.apply(wrapped);
    },
  };
}

interface WrapContextDeps extends ErrorRoutingDeps {
  readonly pluginName: string;
}

function wrapContext(scope: Context, deps: WrapContextDeps): Context {
  const { pluginName, sink, root, onToken } = deps;
  const report = (where: string, error: unknown): void => {
    const message = error instanceof Error ? `${String(error)}` : String(error);
    sink(where, message);
    scope.emit(pluginEvent, {
      plugin: pluginName,
      kind: "listener-error",
      data: { where, message },
      ts: Date.now(),
    });
  };
  // 落位 root + 回卷链 scope（裁决 9）：手动调用与层回卷都幂等（内核 registerEffect 自清理）
  const placeOnRoot = (disposer: Disposer): Disposer => {
    scope.effect(() => {
      void disposer();
    });
    return disposer;
  };
  const onRoot = root.on as unknown as (t: AnyToken, f: unknown, o?: { readonly prepend?: boolean }) => Disposer;
  return {
    provide: <T>(token: ServiceToken<T>, impl: T): Disposer => {
      onToken?.(token);
      return placeOnRoot(root.provide(token, impl));
    },
    use: <T>(token: ServiceToken<T>): T => scope.use(token),
    tryUse: <T>(token: ServiceToken<T>): T | undefined => scope.tryUse(token),
    waitFor: <T>(token: ServiceToken<T>): Promise<T> => scope.waitFor(token),
    on: (token: AnyToken, fn: unknown, opts?: { readonly prepend?: boolean }): Disposer => {
      onToken?.(token);
      const mode = "mode" in token ? token.mode : "emit";
      const original = fn as (payload: unknown) => unknown;
      const routed =
        mode === "emit"
          ? (payload: unknown): unknown => {
              // emit：吞（与内核隔离一致）——归属在此记录
              try {
                const out = original(payload);
                if (isThenable(out)) {
                  (out as Promise<unknown>).catch((error: unknown) => report(`${token.name}@emit`, error));
                }
                return out;
              } catch (error) {
                report(`${token.name}@emit`, error);
                return undefined;
              }
            }
          : (payload: unknown): unknown => {
              // 关键路径：记录后原样上抛（同步 throw 与 async rejected promise 两条路都接）
              try {
                const out = original(payload);
                if (isThenable(out)) {
                  return (out as Promise<unknown>).catch((error: unknown) => {
                    report(`${token.name}@${mode}`, error);
                    throw error;
                  });
                }
                return out;
              } catch (error) {
                report(`${token.name}@${mode}`, error);
                throw error;
              }
            };
      return placeOnRoot(onRoot(token, routed, opts));
    },
    emit: <T>(token: EventToken<T>, payload: T): void => scope.emit(token, payload),
    dispatch: (token: AnyToken, payloadOrInput: unknown, final?: unknown): Promise<unknown> =>
      (scope.dispatch as (t: AnyToken, i: unknown, f?: unknown) => Promise<unknown>)(
        token,
        payloadOrInput,
        final,
      ),
    createChain: <I, O>(final: (input: I) => Promise<O>): Chain<I, O> => scope.createChain(final),
    onChain: <I, O>(
      chain: Chain<I, O>,
      middleware: ChainMiddleware<I, O>,
      opts?: { readonly prepend?: boolean },
    ): Disposer =>
      (scope.onChain as (
        c: Chain<I, O>,
        m: ChainMiddleware<I, O>,
        o?: { readonly prepend?: boolean },
      ) => Disposer)(chain, middleware, opts),
    effect: (disposer: Disposer): void => scope.effect(disposer),
    dispose: (): Promise<void> => scope.dispose(),
    scope: (filter: ScopeFilter): Context => scope.scope(filter),
  } as unknown as Context;
}
