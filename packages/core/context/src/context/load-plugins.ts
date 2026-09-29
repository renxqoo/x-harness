import { stderrLine } from "../stderr-line.ts";
import { pluginError, pluginLoaded, pluginUnloaded } from "./vocab.ts";
import type {
  AnyToken,
  Chain,
  ChainMiddleware,
  Context,
  Disposer,
  EventToken,
  Plugin,
  ScopeFilter,
  ServiceToken,
} from "./types.ts";

function assertValid(plugins: readonly Plugin[]): void {
  const names = new Set<string>();
  for (const plugin of plugins) {
    const raw: unknown = plugin;
    if (typeof raw === "function") {
      const name = (raw as { readonly name?: string }).name ?? "anonymous";
      throw new Error(`plugin is a factory function, not a plugin — call it: ${name}()`);
    }
    if (typeof plugin.name !== "string" || plugin.name.length === 0) {
      throw new Error("plugin name must be a non-empty string");
    }
    if (typeof plugin.apply !== "function") {
      throw new Error(`plugin "${plugin.name}" has no apply function`);
    }
    if (names.has(plugin.name)) {
      throw new Error(`duplicate plugin name: "${plugin.name}"`);
    }
    names.add(plugin.name);
  }
  for (const plugin of plugins) {
    for (const dep of plugin.inject ?? []) {
      if (!names.has(dep)) {
        throw new Error(`plugin "${plugin.name}" injects unknown plugin "${dep}"`);
      }
    }
  }
}


function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1]!, dp[j]!) + 1;
      prev = temp;
    }
  }
  return dp[b.length]!;
}

function topoOrder(plugins: readonly Plugin[]): Plugin[] {
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin] as const));
  const ordered: Plugin[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (plugin: Plugin, stack: readonly string[]): void => {
    const mark = state.get(plugin.name);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new Error(`cyclic plugin dependency: ${[...stack, plugin.name].join(" -> ")}`);
    }
    state.set(plugin.name, "visiting");
    for (const dep of plugin.inject ?? []) {
      visit(byName.get(dep) as Plugin, [...stack, plugin.name]);
    }
    for (const dep of plugin.softInject ?? []) {
      const target = byName.get(dep);
      if (target !== undefined) {
        visit(target, [...stack, plugin.name]);
      } else {
        const near = [...byName.keys()].find((n) => editDistance(n, dep) <= 2 && n !== dep);
        if (near !== undefined) {
          stderrLine(`[softInject] plugin "${plugin.name}" declares "${dep}" — did you mean "${near}"?`);
        }
      }
    }
    state.set(plugin.name, "done");
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin, []);
  return ordered;
}

function captureRegistrations(ctx: Context, captured: Disposer[]): Context {
  const track = (disposer: Disposer): Disposer => {
    captured.push(disposer);
    return disposer;
  };
  const wrapper = {
    provide: <T>(token: ServiceToken<T>, impl: T): Disposer => track(ctx.provide(token, impl)),
    use: <T>(token: ServiceToken<T>): T => ctx.use(token),
    tryUse: <T>(token: ServiceToken<T>): T | undefined => ctx.tryUse(token),
    waitFor: <T>(token: ServiceToken<T>): Promise<T> => ctx.waitFor(token),
    on: (token: AnyToken, fn: unknown): Disposer =>
      track((ctx.on as (token: AnyToken, fn: unknown) => Disposer)(token, fn)),
    emit: <T>(token: EventToken<T>, payload: T): void => ctx.emit(token, payload),
    dispatch: (token: AnyToken, payloadOrInput: unknown, final?: unknown): Promise<unknown> =>
      (ctx.dispatch as (t: AnyToken, i: unknown, f?: unknown) => Promise<unknown>)(
        token,
        payloadOrInput,
        final,
      ),
    createChain: <I, O>(final: (input: I) => Promise<O>): Chain<I, O> => ctx.createChain(final),
    onChain: <I, O>(chain: Chain<I, O>, middleware: ChainMiddleware<I, O>): Disposer =>
      track(ctx.onChain(chain, middleware)),
    effect: (disposer: Disposer): void => {
      captured.push(disposer);
    },
    dispose: (): Promise<void> => ctx.dispose(),
    scope: (filter: ScopeFilter): Context => ctx.scope(filter),
  };
  return wrapper as Context;
}

export async function loadPlugins(
  ctx: Context,
  plugins: readonly Plugin[],
): Promise<readonly Disposer[]> {
  assertValid(plugins);
  const ordered = topoOrder(plugins);
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  ctx.effect(() => settled);
  const unloaders: Disposer[] = [];
  for (const plugin of ordered) {
    const captured: Disposer[] = [];
    try {
      const disposer = await plugin.apply(captureRegistrations(ctx, captured));
      if (disposer !== undefined && disposer !== null) {
        if (typeof disposer !== "function") {
          throw new Error(`plugin "${plugin.name}" apply must return a disposer function or void — got ${typeof disposer}`);
        }
        captured.push(disposer);
      }
      let done = false;
      const unload: Disposer = async () => {
        if (done) return;
        done = true;
        const failures: unknown[] = [];
        for (let index = captured.length - 1; index >= 0; index -= 1) {
          const unwind = captured[index];
          if (unwind === undefined) continue;
          try {
            await unwind();
          } catch (error) {
            failures.push(error);
          }
        }
        ctx.emit(pluginUnloaded, { plugin: plugin.name });
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "plugin unload failures");
      };
      ctx.effect(unload);
      unloaders.push(unload);
      ctx.emit(pluginLoaded, { plugin: plugin.name });
    } catch (error) {
      release();
      ctx.emit(pluginError, { plugin: plugin.name, error: String(error) });
      for (let index = captured.length - 1; index >= 0; index -= 1) {
        const unwind = captured[index];
        if (unwind === undefined) continue;
        try {
          await unwind();
        } catch {
        }
      }
      try {
        await ctx.dispose();
      } catch (disposeError) {
        const detail =
          disposeError instanceof Error ? `${disposeError.name}: ${disposeError.message}` : String(disposeError);
        stderrLine(`[x-harness] dispose during plugin load failure also failed: ${detail}`);
      }
      release();
      throw error;
    }
  }
  release();
  return unloaders;
}
