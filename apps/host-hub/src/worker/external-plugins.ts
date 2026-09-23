// 装配期外部插件装载（docs/PLUGINS.md 契约 4）：world 建成后、会话创建前，经
// plugin-manager（process 模式）装载词表启用件——usage 计数覆盖会话第一步。
// 单件失败（解析/install）stderr 告警跳过，装配不挂。卸载在 teardownWorld 先行
// （审计落盘），失败不短路收殓。
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { createFileAudit, createPluginManager, pluginManagerService } from "@x-harness/plugin-manager";
import { BUILTIN_PLUGINS, enabledBuiltinPlugins } from "../shared/plugins-catalog.ts";

/** 解析：module 说明符 → 绝对路径（import.meta.resolve 返回 file:// URL——必须
 *  规范化；roots/approveInstall/install path 三处同源派生本函数结果） */
export const resolveModuleBySpecifier = (module: string): string => fileURLToPath(import.meta.resolve(module));

export interface ExternalPluginsDeps {
  /** 测试缝：解析失败注入 */
  readonly resolve?: (module: string) => string;
  /** 测试缝：坏模块注入（install 失败降级面） */
  readonly loadModule?: (path: string) => Promise<unknown>;
}

export interface InstallExternalPluginsInput {
  readonly ctx: Context;
  readonly agentDir: string;
  readonly disabled?: readonly string[];
}

export async function installExternalPlugins(input: InstallExternalPluginsInput, deps?: ExternalPluginsDeps): Promise<void> {
  const resolve = deps?.resolve ?? resolveModuleBySpecifier;
  const entries: { name: string; path: string }[] = [];
  for (const name of enabledBuiltinPlugins(input.disabled)) {
    const entry = BUILTIN_PLUGINS[name];
    if (entry === undefined) continue; // 词表外名（防御——settings 面已整键丢弃）
    try {
      entries.push({ name, path: resolve(entry.module) });
    } catch (error) {
      process.stderr.write(`hub:worker: plugin "${name}" resolve failed: ${String(error)}\n`);
    }
  }
  if (entries.length === 0) return;
  const allowed = new Set(entries.map((entry) => entry.path));
  await loadPlugins(input.ctx, [
    createPluginManager({
      ctx: input.ctx,
      roots: [...new Set(entries.map((entry) => dirname(entry.path)))],
      approveInstall: ({ path }) => allowed.has(path),
      mode: "process",
      audit: createFileAudit(join(input.agentDir, "plugins", "audit.jsonl")),
      ...(deps?.loadModule !== undefined ? { loadModule: deps.loadModule } : {}),
    }),
  ]);
  const svc = input.ctx.use(pluginManagerService);
  for (const { name, path } of entries) {
    // install 可能 reject（loadModule 拒绝——包缺失/顶层抛错），与 Result 失败
    // 同降级律：stderr 告警跳过，装配不挂（docs/PLUGINS.md 契约 4）
    try {
      const installed = await svc.install({ path, mode: "process" });
      if (!installed.ok) {
        process.stderr.write(`hub:worker: plugin "${name}" install failed: ${installed.reason}\n`);
      }
    } catch (error) {
      process.stderr.write(`hub:worker: plugin "${name}" install rejected: ${String(error)}\n`);
    }
  }
}

/** teardown 先行卸载：审计落盘（install/uninstall 生命周期对——failed 记录同样
 *  清除，audit 记 "uninstall" 带留痕细节）；失败仅告警不短路（否则 world 泄漏）。
 *  未装载（agentDir 缺席跳过/词表空）= 无事可做。 */
export async function uninstallExternalPlugins(ctx: Context): Promise<void> {
  const svc = ctx.tryUse(pluginManagerService);
  if (svc === undefined) return;
  for (const record of svc.list()) {
    const uninstalled = await svc.uninstall(record.name);
    if (!uninstalled.ok) {
      process.stderr.write(`hub:worker: plugin "${record.name}" uninstall failed: ${uninstalled.reason}\n`);
    }
  }
}
