// 任务件出口（docs/TASKS.md）：task_output/task_stop 工具插件 + TaskHub 服务契约。
// bash 源适配（source-bash）经工厂参数 bashTasks 装配；agent 源由 agent-delegation 注册。

export { createTaskToolsPlugin } from "./plugin.ts";
export type { TaskToolsOptions } from "./plugin.ts";
export { taskHub } from "./tokens.ts";
export type { TaskHub, TaskOutputOptions, TaskOutcome, TaskProbe, TaskSource } from "./tokens.ts";
export { notFoundText } from "./tools.ts";
