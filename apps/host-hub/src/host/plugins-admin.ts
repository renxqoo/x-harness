// 插件管理面（plugin-runtime §M1）：list（builtin + vendor + disabled + 装载态
// 合并）/ inspect / install / uninstall / set_enabled / remove / errors。
// install 是「拷 vendor + 落 registry」；热装（活跃 thread world 内即时生效）是
// plugins/hot_install 线程域命令——本文件只管盘上事实与全局清单。
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import { readHubSettings, updateHubSettings } from "../shared/settings-store.ts";
import { builtinPluginNames, isBuiltinPluginName, knownPluginNames, vendorLoadable } from "../shared/plugins-catalog.ts";
import { readVendorRegistry } from "../shared/plugins-registry.ts";
import type { VendorPluginEntry } from "../shared/plugins-registry.ts";
import { inspectPluginSources, installPlugin, removePlugin } from "./plugins-install.ts";

export interface PluginRow {
  readonly name: string;
  readonly source: "builtin" | "vendor";
  readonly origin: "manual" | "agent" | undefined;
  readonly version: number | undefined;
  readonly enabled: boolean;
  readonly status: "active" | "failed" | "disabled" | "unloaded";
  /** status != active 时的原因（apiVersion 不匹配 / 未装载等——宿主本地化展示） */
  readonly disabledReason: string | undefined;
  readonly description: string | undefined;
  readonly path: string | undefined;
}

export interface PluginsAdminSpec {
  readonly agentDir: string;
  /** 装载态快照（pluginManagerService.list() 的镜像——host 侧经 worker 状态面注入；
   *  缺席 = 视为未装载，与「新 worker 装配前」一致） */
  readonly loaded?: readonly { name: string; mode: string; status: string }[];
}

/** builtin 装载态归并：disabled > unloaded > active/failed */
function builtinStatus(enabled: boolean, record: { status: string } | undefined): PluginRow["status"] {
  if (!enabled) return "disabled";
  if (record === undefined) return "unloaded";
  return record.status === "active" ? "active" : "failed";
}

function rowOfBuiltin(name: string, disabled: Set<string>, loaded: Map<string, { status: string }>): PluginRow {
  const record = loaded.get(name);
  const enabled = !disabled.has(name);
  return {
    name,
    source: "builtin",
    origin: undefined,
    version: undefined,
    enabled,
    status: builtinStatus(enabled, record),
    disabledReason: undefined,
    description: undefined,
    path: undefined,
  };
}

/** vendor 装载态归并：disabled > apiVersion 拒载 > unloaded > active/failed */
function vendorStatus(enabled: boolean, loadable: { ok: boolean }, record: { status: string } | undefined): PluginRow["status"] {
  if (!enabled || !loadable.ok) return "disabled";
  if (record === undefined) return "unloaded";
  return record.status === "active" ? "active" : "failed";
}

function rowOfVendor(entry: VendorPluginEntry, disabled: Set<string>, loaded: Map<string, { status: string }>): PluginRow {
  const record = loaded.get(entry.name);
  const enabled = !disabled.has(entry.name);
  const loadable = vendorLoadable(entry);
  const status = vendorStatus(enabled, loadable, record);
  return {
    name: entry.name,
    source: "vendor",
    origin: entry.origin,
    version: entry.apiVersion,
    enabled,
    status,
    disabledReason: loadable.ok ? undefined : loadable.reason,
    description: entry.description,
    path: entry.dir,
  };
}

export async function listPlugins(spec: PluginsAdminSpec): Promise<{ plugins: PluginRow[] }> {
  const [settings, vendor] = await Promise.all([readHubSettings(spec.agentDir), readVendorRegistry(spec.agentDir)]);
  const disabled = new Set(settings["plugins.disabled"] ?? []);
  const loaded = new Map((spec.loaded ?? []).map((row) => [row.name, { status: row.status }]));
  const rows = [
    ...builtinPluginNames().map((name) => rowOfBuiltin(name, disabled, loaded)),
    ...vendor.map((entry) => rowOfVendor(entry, disabled, loaded)),
  ];
  return { plugins: rows };
}

export interface SetPluginEnabledSpec extends PluginsAdminSpec {
  readonly name: string;
  readonly enabled: boolean;
}

export async function setPluginEnabled(spec: SetPluginEnabledSpec): Promise<{ ok: true } | { ok: false; error: HubErrorShape }> {
  const vendor = await readVendorRegistry(spec.agentDir);
  const known = new Set(knownPluginNames(vendor));
  if (!known.has(spec.name)) {
    return { ok: false, error: hubError("state_conflict", `unknown plugin: ${spec.name} (available: ${[...known].sort().join(", ")})`) };
  }
  await updateHubSettings(spec.agentDir, (current) => {
    const list = new Set(current["plugins.disabled"] ?? []);
    if (spec.enabled) list.delete(spec.name);
    else list.add(spec.name);
    return { ...current, "plugins.disabled": [...list].sort() };
  });
  return { ok: true };
}

/** 卸载语义分叉：builtin 只可 disable（remove 拒）；vendor 可 remove（目录 + 条目） */
export function builtinNotRemovable(name: string): boolean {
  return isBuiltinPluginName(name);
}

export { inspectPluginSources, installPlugin, removePlugin };
