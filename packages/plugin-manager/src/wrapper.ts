import type { AnyToken, Chain, ChainMiddleware, Context, Disposer, EventToken, Plugin, PluginCapabilities, ScopeFilter, ServiceToken } from "@x-harness/core";
import { pluginEvent } from "@x-harness/core";
import { META_TOKEN_NAMES } from "./capabilities.ts";

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Promise<unknown>).then === "function" &&
    typeof (value as Promise<unknown>).catch === "function"
  );
}

export type ErrorSink = (where: string, message: string) => void;

export interface ErrorRoutingDeps {
  readonly sink: ErrorSink;
  readonly root: Context;
  readonly onToken?: (token: AnyToken) => void;
  readonly capabilities?: PluginCapabilities;
}

export function wrapPluginForErrorRouting(plugin: Plugin, deps: ErrorRoutingDeps): Plugin {
  return {
    name: plugin.name,
    apply: (scope: Context) => {
      const wrapped = wrapContext(scope, { ...deps, pluginName: plugin.name });
      return plugin.apply(wrapped, deps.capabilities);
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
      if (META_TOKEN_NAMES.has(token.name)) {
        throw new Error(`listening on meta token not allowed: ${token.name}`);
      }
      onToken?.(token);
      const mode = "mode" in token ? token.mode : "emit";
      const original = fn as (payload: unknown) => unknown;
      const routed =
        mode === "emit"
          ? (payload: unknown): unknown => {
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
