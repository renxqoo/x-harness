import { runWorker as runWorkerImpl } from "@x-harness/agent-sdk/src/executor-worker/worker-entry.ts";
import type { WorkerBoot as WorkerBootBase } from "@x-harness/agent-sdk/src/executor-worker/worker-entry.ts";
import { createWorkerCommands } from "./worker-commands.ts";

export interface WorkerBoot extends WorkerBootBase {
  commandsFactory?: (rt: never) => Map<string, (input: Record<string, unknown>) => Promise<void>>;
}

export async function runWorker(boot: WorkerBoot): Promise<void> {
  await runWorkerImpl({
    ...boot,
    ...(boot.commandsFactory !== undefined ? { commandsFactory: boot.commandsFactory } : { commandsFactory: (rt) => createWorkerCommands(rt as never) }),
  });
}

export type { WorkerRuntimeLike } from "@x-harness/agent-sdk/src/executor-worker/worker-types.ts";
