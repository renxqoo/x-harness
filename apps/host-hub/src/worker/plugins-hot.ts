// 插件热装/热卸（线程域命令——plugin-runtime §M1/§7）：在当前 thread 的 world ctx
// 内直调 pluginManagerService。热装只收 name（装载事实从 registry 现读——agent 与
// UI 都无法直传路径绕门）；vendor 件恒 worker 模式（P1 编排层：路径在 vendor 根内
// 派生 + mode 落死）；builtin 热装走词表解析。热卸 = 同名锁 + 依赖检查（引擎语义）。
import { pluginManagerService } from "@x-harness/plugin-manager";
import { hubError } from "../shared/errors.ts";
import { readVendorRegistry, vendorRootOf } from "../shared/plugins-registry.ts";
import { BUILTIN_PLUGINS } from "../shared/plugins-catalog.ts";
import { pluginEntryPath } from "../host/plugins-install.ts";
import { respond, requireThread } from "./worker-commands.ts";
import type { CommandInput, WorkerRuntime } from "./worker-commands.ts";

/** 热装：name → 装载路径（builtin 词表解析 / vendor registry + 入口探测）。
 *  路径永远不接受请求直传——P1 编排层不变式。 */
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
