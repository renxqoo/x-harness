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

export const resolveModuleBySpecifier = (module: string): string => fileURLToPath(import.meta.resolve(module));

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
  readonly resolve?: (module: string) => string;
  readonly loadModule?: (path: string) => Promise<unknown>;
  readonly vendorEntries?: readonly VendorPluginEntry[];
  readonly resolveVendorEntry?: (entry: VendorPluginEntry) => string | undefined;
}

export interface InstallExternalPluginsInput {
  readonly ctx: Context;
  readonly agentDir: string;
  readonly disabled?: readonly string[];
}

async function resolveBuiltinPaths(
  items: readonly (string | VendorPluginEntry)[],
  resolve: (module: string) => string,
): Promise<Map<string, string>> {
  const builtinPaths = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const entry = BUILTIN_PLUGINS[item];
    if (entry === undefined) continue;
    try {
      builtinPaths.set(item, resolve(entry.module));
    } catch (error) {
      process.stderr.write(`hub:worker: plugin "${item}" resolve failed: ${String(error)}\n`);
    }
  }
  return builtinPaths;
}

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
