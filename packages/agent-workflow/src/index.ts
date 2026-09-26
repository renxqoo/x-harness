// @x-harness/agent-workflow：件 16 插件包（journal/锁/resolve 先行——§12.5 ②；
// 插件装配/工具面/接缝消费随后落）。

export { resolveWorkflowRoot } from "./resolve.ts";
export { acquireRunLock } from "./lock.ts";
export type { AcquireOutcome, RunLock } from "./lock.ts";
export { openRunJournal, readRun, workflowPluginVersion } from "./journal.ts";
export type { JournalWriter, OpenResult, RunHeader } from "./journal.ts";
