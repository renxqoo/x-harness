import type { VendorPluginEntry } from "./plugins-registry.ts";

export interface BuiltinPluginEntry {
  readonly module: string;
}

export const BUILTIN_PLUGINS: Readonly<Record<string, BuiltinPluginEntry>> = Object.freeze({
  "token-analytics": { module: "@x-harness/token-analytics" },
});

export function builtinPluginNames(): readonly string[] {
  return Object.keys(BUILTIN_PLUGINS);
}

export function isBuiltinPluginName(name: string): boolean {
  return Object.hasOwn(BUILTIN_PLUGINS, name);
}

export function enabledBuiltinPlugins(disabled: readonly string[] | undefined): readonly string[] {
  if (disabled === undefined || disabled.length === 0) return builtinPluginNames();
  const excluded = new Set(disabled);
  return builtinPluginNames().filter((name) => !excluded.has(name));
}


export const PLUGIN_KERNEL_API_VERSION = 1;

export function vendorLoadable(entry: VendorPluginEntry): { ok: true } | { ok: false; reason: string } {
  if (entry.apiVersion !== PLUGIN_KERNEL_API_VERSION) {
    return {
      ok: false,
      reason: `plugin apiVersion ${entry.apiVersion} does not match kernel ${PLUGIN_KERNEL_API_VERSION}`,
    };
  }
  return { ok: true };
}

export function enabledPlugins(
  disabled: readonly string[] | undefined,
  vendor: readonly VendorPluginEntry[],
): readonly (string | VendorPluginEntry)[] {
  const excluded = new Set(disabled ?? []);
  const builtins = builtinPluginNames().filter((name) => !excluded.has(name));
  const vendors = vendor.filter((entry) => !excluded.has(entry.name)).filter((entry) => vendorLoadable(entry).ok);
  return [...builtins, ...vendors];
}

export function knownPluginNames(vendor: readonly VendorPluginEntry[]): readonly string[] {
  return [...builtinPluginNames(), ...vendor.map((entry) => entry.name)];
}
