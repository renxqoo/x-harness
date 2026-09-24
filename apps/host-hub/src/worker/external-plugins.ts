// 装配期外部插件装载（docs/PLUGINS.md 契约 4 + plugin-runtime §M1）：
// world 建成后、会话创建前，经 plugin-manager 装载启用件——builtin 走 process 模式
//（共享模块实例——token 身份同一），vendor 走 worker 模式（线程隔离——P1 不变式，
// 编排层直接以 mode 落死，请求方无法覆写）。WORLD_TOKENS 补齐 F-B 词表缺口。
// 单件失败（解析/install）stderr 告警跳过，装配不挂。卸载在 teardownWorld 先行
//（审计落盘），失败不短路收殓。
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadPlugins } from "@x-harness/core";
import type { AnyToken, Context } from "@x-harness/core";
import { sessionAuditEvent, sessionCreated, sessionDisposed, sessionEvent, sessionFlush, sessionStore } from "@x-harness/session";
import { systemPrompt } from "@x-harness/system-prompt";
import { toolRegistry } from "@x-harness/tools";
import { llmRuntime } from "@x-harness/llm";
import { createFileAudit, createPluginManager, pluginManagerService } from "@x-harness/plugin-manager";
import { BUILTIN_PLUGINS, enabledPlugins } from "../shared/plugins-catalog.ts";
import { readVendorRegistry, vendorRootOf } from "../shared/plugins-registry.ts";
import type { VendorPluginEntry } from "../shared/plugins-registry.ts";
import { pluginEntryPath } from "../host/plugins-install.ts";

/** 解析：module 说明符 → 绝对路径（import.meta.resolve 返回 file:// URL——必须
 *  规范化；roots/approveInstall/install path 三处同源派生本函数结果） */
export const resolveModuleBySpecifier = (module: string): string => fileURLToPath(import.meta.resolve(module));

/** 世界 token 词表（F-B 补账）：caps 可见面与 worker 桥白名单的单一真相。
 *  元能力 token（plugin-manager 等）不在此列——capabilities.ts META 层排除。 */
export const WORLD_TOKENS: readonly AnyToken[] = Object.freeze([
  sessionStore,
  systemPrompt,
  toolRegistry,
  llmRuntime,
  sessionCreated,
  sessionEvent,
  sessionAuditEvent,
  sessionFlush,
  sessionDisposed,
]);

export interface ExternalPluginsDeps {
  /** 测试缝：解析失败注入 */
  readonly resolve?: (module: string) => string;
  /** 测试缝：坏模块注入（install 失败降级面） */
  readonly loadModule?: (path: string) => Promise<unknown>;
  /** 测试缝：vendor 清单注入（缺省读 registry 文件） */
  readonly vendorEntries?: readonly VendorPluginEntry[];
  /** 测试缝：vendor 入口探测注入（缺省 pluginEntryPath） */
  readonly resolveVendorEntry?: (entry: VendorPluginEntry) => string | undefined;
}

export interface InstallExternalPluginsInput {
  readonly ctx: Context;
  readonly agentDir: string;
  readonly disabled?: readonly string[];
}

/** builtin 解析（词表内 + 未 disabled）——resolve 失败单件告警跳过 */
async function resolveBuiltinPaths(
  items: readonly (string | VendorPluginEntry)[],
  resolve: (module: string) => string,
): Promise<Map<string, string>> {
  const builtinPaths = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const entry = BUILTIN_PLUGINS[item];
    if (entry === undefined) continue; // 词表外名（防御——settings 面已整键丢弃）
    try {
      builtinPaths.set(item, resolve(entry.module));
    } catch (error) {
      process.stderr.write(`hub:worker: plugin "${item}" resolve failed: ${String(error)}\n`);
    }
  }
  return builtinPaths;
}

/** vendor 入口探测（apiVersion 门在 enabledPlugins 已滤除；入口缺席告警跳过） */
async function resolveVendorTargets(
  items: readonly (string | VendorPluginEntry)[],
  vendorRoot: string,
  deps: ExternalPluginsDeps | undefined,
): Promise<{ name: string; path: string }[]> {
  const vendorTargets: { name: string; path: string }[] = [];
  for (const item of items) {
    if (typeof item === "string") continue;
    const path = deps?.resolveVendorEntry !== undefined ? deps.resolveVendorEntry(item) : await pluginEntryPath(vendorRoot, item);
    if (path === undefined) {
      process.stderr.write(`hub:worker: plugin "${item.name}" entry missing in vendor tree\n`);
      continue;
    }
    vendorTargets.push({ name: item.name, path });
  }
  return vendorTargets;
}

export async function installExternalPlugins(input: InstallExternalPluginsInput, deps?: ExternalPluginsDeps): Promise<void> {
  const resolve = deps?.resolve ?? resolveModuleBySpecifier;
  const vendorRoot = vendorRootOf(input.agentDir);
  const vendor = deps?.vendorEntries ?? (await readVendorRegistry(input.agentDir));
  const items = enabledPlugins(input.disabled, vendor);
  const builtinPaths = await resolveBuiltinPaths(items, resolve);
  const vendorTargets = await resolveVendorTargets(items, vendorRoot, deps);
  if (builtinPaths.size === 0 && vendorTargets.length === 0) return;
  const allowedBuiltin = new Set(builtinPaths.values());
  const allowed = (path: string): boolean => allowedBuiltin.has(path) || path.startsWith(`${vendorRoot}/`);
  await loadPlugins(input.ctx, [
    createPluginManager({
      ctx: input.ctx,
      roots: [...new Set([...builtinPaths.values()].map((path) => dirname(path))), vendorRoot],
      vendorRoots: [vendorRoot],
      approveInstall: ({ path }) => allowed(path),
      mode: "process",
      tokens: [...WORLD_TOKENS],
      audit: createFileAudit(join(input.agentDir, "plugins", "audit.jsonl")),
      ...(deps?.loadModule !== undefined ? { loadModule: deps.loadModule } : {}),
    }),
  ]);
  const svc = input.ctx.use(pluginManagerService);
  for (const [name, path] of builtinPaths) {
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
  for (const { name, path } of vendorTargets) {
    // P1 编排层：vendor 件恒 worker——请求面不给 mode 覆写口，引擎 vendorRoots 是第二层
    try {
      const installed = await svc.install({ path, mode: "worker", replace: true });
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
