import { join } from "node:path";
import { runWorker } from "./worker.ts";

export async function run(): Promise<void> {
  const agentDir = process.env["HUB_AGENT_DIR"];
  if (agentDir === undefined || agentDir === "") {
    process.stderr.write("hub:worker: HUB_AGENT_DIR required\n");
    process.exit(2);
  }
  const sessionsRoot = process.env["HUB_SESSIONS_ROOT"] ?? join(agentDir, "sessions");
  await runWorker({ agentDir, sessionsRoot });
}

if (import.meta.main && process.env["HUB_WORKER_DISPATCHED"] !== "1") {
  run().catch((error: unknown) => {
    process.stderr.write(`hub:worker: boot failure: ${String(error)}\n`);
    process.exit(1);
  });
}
