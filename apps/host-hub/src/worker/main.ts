// worker 入口（main guard；run 可单测——覆盖率口径零覆盖文件计 0%）。
// 环境契约：HUB_AGENT_DIR（配置目录）、HUB_SESSIONS_ROOT（会话根，缺省
// <agentDir>/sessions）。HUB_WORKER_DISPATCHED 哨兵：产物形态 host 双角色分派后
// 抑制本文件 main-guard 重复执行（双 hello 回归锚）。
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
