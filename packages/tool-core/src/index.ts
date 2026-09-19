// 工具侧共享基础设施内核（docs/TOOLBOX.md §0/§1）：路径门 + 观察登记 + 工具插件工厂。
// 边界：@x-harness/tools 是注册表/调度管线契约；本包是命令工具包（tool-read/write/bash/grep）
// 的共享实现件——装配方创建 PathGate/ObservedRegistry 实例并穿引给各命令插件工厂
// （read+write 必须共享同一 gate+observed 实例，错穿症状为 FS_NOT_OBSERVED——fail-closed）。

export { PathGate, admitSession } from "./paths.ts";
export type { RealpathFn, RootOverrideOf, SessionAdmitInput } from "./paths.ts";
export { ObservedRegistry } from "./observed.ts";
export type { FileVersion } from "./observed.ts";
export { createToolPlugin } from "./tool-plugin.ts";
export type { ExtraRootsOf, ToolPluginInput } from "./tool-plugin.ts";
