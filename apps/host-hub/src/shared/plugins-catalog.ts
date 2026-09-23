// 内置插件词表 + vendor 双源（docs/PLUGINS.md 契约 3 + plugin-runtime §M1）：
// settings 校验、装配装载、文档三方单一真相。配置用符号名而非路径——settings
// 文件是数据不是代码，不可成为任意路径代码装载入口（信任边界 = 本词表随宿主
// 代码分发 + vendor registry 哈希 pin）。
import type { VendorPluginEntry } from "./plugins-registry.ts";

export interface BuiltinPluginEntry {
  /** 包说明符（装载期解析为绝对路径供 plugin-manager install） */
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

// ── vendor 双源 ─────────────────────────────────────────────────────────────

/** 内核 API 版本门基准（引擎 kernelApiVersion 缺省 1——与 plugin-manager 同源） */
export const PLUGIN_KERNEL_API_VERSION = 1;

/** vendor 件可装载判定：apiVersion 不匹配 = 拒载（条目保留——list 透出原因，可 remove/重装） */
export function vendorLoadable(entry: VendorPluginEntry): { ok: true } | { ok: false; reason: string } {
  if (entry.apiVersion !== PLUGIN_KERNEL_API_VERSION) {
    return {
      ok: false,
      reason: `plugin apiVersion ${entry.apiVersion} does not match kernel ${PLUGIN_KERNEL_API_VERSION}`,
    };
  }
  return { ok: true };
}

/** 合并装载面：builtin 启用名 + 可装载 vendor 条目（disabled 名单对两源同语义） */
export function enabledPlugins(
  disabled: readonly string[] | undefined,
  vendor: readonly VendorPluginEntry[],
): readonly (string | VendorPluginEntry)[] {
  const excluded = new Set(disabled ?? []);
  const builtins = builtinPluginNames().filter((name) => !excluded.has(name));
  const vendors = vendor.filter((entry) => !excluded.has(entry.name)).filter((entry) => vendorLoadable(entry).ok);
  return [...builtins, ...vendors];
}

/** 已知名全集（settings plugins.disabled 校验放宽面：builtin ∪ 已装 vendor 名） */
export function knownPluginNames(vendor: readonly VendorPluginEntry[]): readonly string[] {
  return [...builtinPluginNames(), ...vendor.map((entry) => entry.name)];
}
