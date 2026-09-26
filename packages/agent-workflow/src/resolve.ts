// 目录解析（docs/AGENT-WORKFLOW.md §3.2——仓库既有模式，插件零目录知识）：
// 显式传入 > X_HARNESS_WORKFLOW_DIR > harnessHome/workflows（X_HARNESS_HOME 随根重定位）。

import { homedir } from "node:os";
import { join } from "node:path";

/** 三段链（harnessHome 已含 X_HARNESS_HOME > ~/.x-harness 兜底——四段伪代码的第三支恒返回） */
export function resolveWorkflowRoot(custom?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (custom !== undefined && custom !== "") return custom;
  const override = env["X_HARNESS_WORKFLOW_DIR"];
  if (override !== undefined && override !== "") return override;
  const home = env["X_HARNESS_HOME"]?.trim();
  if (home !== undefined && home.length > 0) return join(home, "workflows");
  return join(homedir(), ".x-harness", "workflows");
}
