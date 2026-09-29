// hub-gateway CLI（进程形态）：Electron 桌面 App 等外部生命周期 owner 经此 spawn。
// 参数：--agent-dir <dir>（必填）；--host-command <json>（hostOverride，JSON {command,args}）。
import { parseArgs } from "node:util";
import process from "node:process";
import { startGateway } from "./main.ts";

const { values } = parseArgs({
  options: {
    "agent-dir": { type: "string" },
    "host-command": { type: "string" },
  },
});
if (typeof values["agent-dir"] !== "string" || values["agent-dir"].length === 0) {
  process.stderr.write("usage: gateway-cli --agent-dir <dir> [--host-command <json>]\n");
  process.exit(2);
}
let hostOverride: { command: string; args: string[] } | undefined;
if (typeof values["host-command"] === "string" && values["host-command"].length > 0) {
  try {
    const parsed = JSON.parse(values["host-command"]) as { command?: string; args?: string[] };
    if (typeof parsed.command === "string" && Array.isArray(parsed.args)) {
      hostOverride = { command: parsed.command, args: parsed.args };
    }
  } catch {
    process.stderr.write("bad --host-command json\n");
    process.exit(2);
  }
}
const gateway = await startGateway({
  agentDir: values["agent-dir"],
  log: (message) => process.stdout.write(`${message}\n`),
  ...(hostOverride !== undefined ? { hostOverride } : {}),
});
process.stdout.write(`gateway ready: ${gateway.identity.installationId}\n`);
process.on("SIGTERM", () => {
  void gateway.stop().then(() => process.exit(0));
});
