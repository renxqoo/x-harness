// 一命令一包（docs/TOOLBOX.md §0）：bash 前台执行 + 后台任务登记簿。
// BackgroundTasks/TaskRead/TaskSnapshot 是任务动词包（task-tools）的 bash 源消费面——
// 公开导出，装配方经 createBashPlugin({ tasks }) 穿引同一实例。

export { createBashPlugin } from "./plugin.ts";
export type { BashPluginInput, BashLimitsOptions, TaskLimitsOptions } from "./plugin.ts";
export { defaultLimits } from "./bash.ts";
export type { BashLimits } from "./bash.ts";
export { BackgroundTasks, defaultTaskLimits } from "./tasks.ts";
export type { TaskLimits, TaskSnapshot, TaskRead, TaskState } from "./tasks.ts";
