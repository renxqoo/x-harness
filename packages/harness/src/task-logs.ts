// bash 后台任务日志根推导（docs/TASK-PUSH-DESIGN.md §2.2/§2.3）：与 sessionsRoot 同级的
// 宿主数据目录——会话档案一致性的单源推导（宿主装配与 session-delete 级联同源消费，
// 防两处漂移）。

import { dirname, join } from "node:path";

export function taskLogsRootOf(sessionsRoot: string): string {
  return join(dirname(sessionsRoot), "task-logs");
}
