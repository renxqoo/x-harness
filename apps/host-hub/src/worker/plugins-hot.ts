import { pluginManagerService } from "@x-harness/plugin-manager";
import { hubError } from "../shared/errors.ts";
import { readVendorRegistry, vendorRootOf } from "../shared/plugins-registry.ts";
import { BUILTIN_PLUGINS, isBuiltinPluginName, vendorLoadable } from "../shared/plugins-catalog.ts";
import { readHubSettings } from "../shared/settings-store.ts";
import { pluginEntryPath } from "../host/plugins-install.ts";
import { respond, requireThread } from "./worker-commands.ts";
import type { CommandInput, WorkerRuntime } from "./worker-commands.ts";

async function resolveHotInstallPath(rt: WorkerRuntime, name: string): Promise<{ path: string; mode: "process" | "worker" } | undefined> {
  const builtin = BUILTIN_PLUGINS[name];
  if (builtin !== undefined) {
    try {
      const path = fileURLToPath(import.meta.resolve(builtin.module));
      return { path, mode: "process" };
    } catch {
      return undefined;
    }
  }
  const vendorRoot = vendorRootOf(rt.agentDir);
  const entry = (await readVendorRegistry(rt.agentDir)).find((row) => row.name === name);
  if (entry === undefined) return undefined;
  const path = await pluginEntryPath(vendorRoot, entry);
  return path === undefined ? undefined : { path, mode: "worker" };
}

export async function handleHotInstall(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  if (requireThread(rt, { ...input, command: "plugins/hot_install" }) === undefined) return;
  const name = typeof input.name === "string" ? input.name : "";
  if (name === "") {
    respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("invalid_input", "invalid plugin name") });
    return;
  }
  const world = rt.state.world;
  const svc = world?.ctx.tryUse(pluginManagerService);
  if (world === undefined || svc === undefined) {
    respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("capability_plugin", "plugin manager not available in this world") });
    return;
  }
  const settings = await readHubSettings(rt.agentDir);
  if ((settings["plugins.disabled"] ?? []).includes(name)) {
    respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("state_conflict", `plugin is disabled: ${name} (enable it first)`) });
    return;
  }
  if (isBuiltinPluginName(name) === false) {
    const vendorEntry = (await readVendorRegistry(rt.agentDir)).find((row) => row.name === name);
    if (vendorEntry === undefined) {
      respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("state_conflict", `unknown or unresolved plugin: ${name}`) });
      return;
    }
    const loadable = vendorLoadable(vendorEntry);
    if (!loadable.ok) {
      respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("plugin_install_failed", loadable.reason) });
      return;
    }
  }
  const target = await resolveHotInstallPath(rt, name);
  if (target === undefined) {
    respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("state_conflict", `unknown or unresolved plugin: ${name}`) });
    return;
  }
  const installed = await svc.install({ path: target.path, mode: target.mode, replace: true }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!installed.ok) {
    respond(rt, { id: input.id, command: "plugins/hot_install", error: hubError("plugin_install_failed", installed.reason) });
    return;
  }
  respond(rt, {
    id: input.id,
    command: "plugins/hot_install",
    data: { name: installed.value.name, mode: installed.value.mode },
  });
}

export async function handleHotUninstall(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  if (requireThread(rt, { ...input, command: "plugins/hot_uninstall" }) === undefined) return;
  const name = typeof input.name === "string" ? input.name : "";
  if (name === "") {
    respond(rt, { id: input.id, command: "plugins/hot_uninstall", error: hubError("invalid_input", "invalid plugin name") });
    return;
  }
  const world = rt.state.world;
  const svc = world?.ctx.tryUse(pluginManagerService);
  if (world === undefined || svc === undefined) {
    respond(rt, { id: input.id, command: "plugins/hot_uninstall", error: hubError("capability_plugin", "plugin manager not available in this world") });
    return;
  }
  const uninstalled = await svc.uninstall(name, input.force === true ? { force: true } : undefined);
  if (!uninstalled.ok) {
    respond(rt, { id: input.id, command: "plugins/hot_uninstall", error: hubError("plugin_uninstall_failed", uninstalled.reason) });
    return;
  }
  respond(rt, { id: input.id, command: "plugins/hot_uninstall", data: { name } });
}

import { fileURLToPath } from "node:url";
