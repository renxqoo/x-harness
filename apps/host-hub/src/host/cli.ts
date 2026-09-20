// host 入口（DESIGN §1）：单可执行双角色分派（--internal-worker）。环境契约：
// HUB_AGENT_DIR（配置目录；缺省 ~/.x-harness/hub）、HUB_SESSIONS_ROOT（会话根，
// 缺省 <agentDir>/sessions）。HUB_WORKER_DISPATCHED 哨兵：产物形态 dispatch 分支
// 动态 import worker main 后其 import.meta.main 同化为 true——哨兵抑制双重执行
// （双 hello 回归锚）。
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
    process.env["HUB_WORKER_DISPATCHED"] = "1"; // 先置哨兵再动态 import（防双执行）
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
