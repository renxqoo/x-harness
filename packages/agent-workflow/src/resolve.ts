import { homedir } from "node:os";
import { join } from "node:path";

export function resolveWorkflowRoot(custom?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (custom !== undefined && custom !== "") return custom;
  const override = env["X_HARNESS_WORKFLOW_DIR"];
  if (override !== undefined && override !== "") return override;
  const home = env["X_HARNESS_HOME"]?.trim();
  if (home !== undefined && home.length > 0) return join(home, "workflows");
  return join(homedir(), ".x-harness", "workflows");
}
