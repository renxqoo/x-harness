
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
    // 工厂函数自带 name 与 Function.prototype.apply，结构上冒充 Plugin 骗过类型检查——
    // 形状特征：apply 变成「无参调用工厂」（副作用不发生），返回的 Plugin 对象被当
    // disposer 压进 unwind 链（dispose 期 'unwind is not a function'）。装配期 fail-fast
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

/** DFS topo：访问序 = 加载序；遇回边（栈中节点）= 循环依赖 */
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
    // S0 软依赖：在场才建边（缺席跳过——不进未知名校验）；双向软依赖经 visiting 栈暴露为环（约束矛盾 fail-fast）
    for (const dep of plugin.softInject ?? []) {
      const target = byName.get(dep);
      if (target !== undefined) visit(target, [...stack, plugin.name]);
    }
    state.set(plugin.name, "done");
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin, []);
  return ordered;
}

/** apply 期注册捕获：委托真 ctx + 记录 disposer——单插件卸载的回收清单 */
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
    // effect 只入捕获清单不入层账本：由本插件的 composite（经 ctx.effect 注册）统一兜底回卷
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
  // 装配可等待（§5 并发契约的 quiescence 面）：dispose 经此 effect 自动等本批装配 settle——
  // 在飞装配的后续注册落进 disposing 层会 fail-fast，但 dispose 本身不与装配竞速死锁
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
      // disposer 必须是函数：非函数形态在此静默入账 = dispose 期深处 'unwind is not a
      // function'——装配期 fail-fast（典型：apply 误返回了插件对象/配置对象）
      if (disposer !== undefined && disposer !== null) {
        if (typeof disposer !== "function") {
          throw new Error(`plugin "${plugin.name}" apply must return a disposer function or void — got ${typeof disposer}`);
        }
        captured.push(disposer);
      }
      let done = false;
      const unload: Disposer = async () => {
        if (done) return; // 幂等，且与层回卷共用哨兵——绝不双跑
        done = true;
        // 与层回卷同律容错：单个 disposer 抛错不中止（其余必回卷），聚合上抛
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
        ctx.emit(pluginUnloaded, { plugin: plugin.name }); // 卸载完成（含部分失败）广播
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "plugin unload failures");
      };
      ctx.effect(unload); // 层回卷兜底（手动卸载已跑过则 no-op）
      unloaders.push(unload);
      ctx.emit(pluginLoaded, { plugin: plugin.name });
    } catch (error) {
      release(); // 先 settle 装配单元——dispose 的 join effect 等的就是它，后放会自锁
      ctx.emit(pluginError, { plugin: plugin.name, error: String(error) });
      // 本插件已捕获的注册逆序回卷：apply 中途 throw 时 composite 尚未入层账本，
      // 不在此回卷则半装状态泄漏（throw 前已 provide/register 的服务与工具残留）
      for (let index = captured.length - 1; index >= 0; index -= 1) {
        const unwind = captured[index];
        if (unwind === undefined) continue;
        try {
          await unwind();
        } catch {
          /* 容错同 unload composite：单个 disposer 抛错不中止回卷 */
        }
      }
      try {
        await ctx.dispose();
      } catch (disposeError) {
        // 根因优先：apply 错误必须向上抛；回卷错误不吞根因（对抗审查 #9 修复）——stderr 留痕（内核不依赖 console）
        const detail =
          disposeError instanceof Error ? `${disposeError.name}: ${disposeError.message}` : String(disposeError);
        process.stderr.write(
          `[x-harness] dispose during plugin load failure also failed: ${detail}\n`,
        );
      }
      release();
      throw error;
    }
  }
  release();
  return unloaders;
}
