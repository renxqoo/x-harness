import { homedir } from "node:os";
import { join } from "node:path";
import { runHost } from "./host.ts";

async function run(): Promise<void> {
  const agentDir = process.env["HUB_AGENT_DIR"] ?? join(homedir(), ".x-harness", "hub");
  if (agentDir === "") {
    process.stderr.write("hub: HUB_AGENT_DIR required\n");
    process.exit(2);
  }
  const sessionsRoot = process.env["HUB_SESSIONS_ROOT"] ?? join(agentDir, "sessions");
  await runHost({ agentDir, sessionsRoot });
}

if (import.meta.main) {
  if (process.argv.includes("--internal-worker")) {
    process.title = "hub-worker";
    process.env["HUB_WORKER_DISPATCHED"] = "1";
    void import("../worker/main.ts").then((mod) => mod.run().catch((error: unknown) => {
      process.stderr.write(`hub:worker: boot failure: ${String(error)}\n`);
      process.exit(1);
    }));
  } else {
    process.title = "hub-host";
    run().catch((error: unknown) => {
      process.stderr.write(`hub: boot failure: ${String(error)}\n`);
      process.exit(1);
    });
  }
}
