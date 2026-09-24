// 任务件出口（docs/TASKS.md + docs/TASK-PUSH-DESIGN.md §2.1）：task_stop 工具插件 +
// TaskHub 服务契约 + bash 完成通知臂。bash 源适配（source-bash）经工厂参数 bashTasks
// 装配；agent 源由 agent-delegation 注册；读面归日志文件与 [task-notification] 推送。

export { createTaskToolsPlugin } from "./plugin.ts";
export type { TaskToolsOptions } from "./plugin.ts";
export { taskHub } from "./tokens.ts";
export type { TaskHub, TaskOutcome, TaskProbe, TaskSource } from "./tokens.ts";
export { notFoundText } from "./tools.ts";
export { BASH_TASK_NOTIFY_SOURCE, createBashTaskNotifier, readTail, taskNotificationText } from "./notify-bash.ts";
export { commandHead, stateLine } from "./cast.ts";
