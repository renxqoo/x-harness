// tool-bash 件 token：后台任务登记簿共享面。createBashPlugin 把生效实例（外穿或自建）
// provide 为服务——任务动词包（task-tools）经 waitFor 停靠消费，同 ctx 内 bash 工具与
// task_stop 工具与 bash 完成通知臂共享同一实例（可选依赖：无 bash 装配不失败，停靠不发生）。

import { defineService } from "@x-harness/core";
import type { BackgroundTasks } from "./tasks.ts";

export const backgroundTasks = defineService<BackgroundTasks>("background-tasks");
