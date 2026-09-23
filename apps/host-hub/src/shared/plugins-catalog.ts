// 内置正式插件词表（docs/PLUGINS.md 契约 3）：settings 校验、装配装载、文档
// 三方单一真相。配置用符号名而非路径——settings 文件是数据不是代码，不可成为
// 任意路径代码装载入口（信任边界 = 本词表随宿主代码分发）。
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

/** 启用面 = 词表 − disabled（缺省全装载——内置件随宿主分发受信） */
export function enabledBuiltinPlugins(disabled: readonly string[] | undefined): readonly string[] {
  if (disabled === undefined || disabled.length === 0) return builtinPluginNames();
  const excluded = new Set(disabled);
  return builtinPluginNames().filter((name) => !excluded.has(name));
}
