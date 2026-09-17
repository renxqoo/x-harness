// 插件加载器（docs/CONTEXT.md §5）：inject 按插件名 topo 排序；
// 循环依赖 / 重名 / 缺依赖 = 装配期 throw（预扫描，未跑任何 apply 前拒绝）；
// apply 抛错 → plugin/error + 整体回卷（IMPL 裁决 2：装配阶段 ctx 视为不可用，dispose 全层）。

import { pluginError, pluginLoaded } from "./vocab.ts";
import type { Context, Plugin } from "./types.ts";

function assertValid(plugins: readonly Plugin[]): void {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (typeof plugin.name !== "string" || plugin.name.length === 0) {
      throw new Error("plugin name must be a non-empty string");
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
    state.set(plugin.name, "done");
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin, []);
  return ordered;
}

export async function loadPlugins(ctx: Context, plugins: readonly Plugin[]): Promise<void> {
  assertValid(plugins);
  for (const plugin of topoOrder(plugins)) {
    try {
      const disposer = await plugin.apply(ctx);
      if (disposer !== undefined && disposer !== null) ctx.effect(disposer);
      ctx.emit(pluginLoaded, { plugin: plugin.name });
    } catch (error) {
      ctx.emit(pluginError, { plugin: plugin.name, error: String(error) });
      try {
        await ctx.dispose();
      } catch (disposeError) {
        // 根因优先：apply 错误必须向上抛；回卷错误不吞根因（对抗审查 #9 修复）
        console.error("[x-harness] dispose during plugin load failure also failed", disposeError);
      }
      throw error;
    }
  }
}
