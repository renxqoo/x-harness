import { dirname, join } from "node:path";

export function taskLogsRootOf(sessionsRoot: string): string {
  return join(dirname(sessionsRoot), "task-logs");
}
