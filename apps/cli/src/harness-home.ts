// x-harness home 根定位（docs/CLI.md §2.1）：$X_HARNESS_HOME 覆盖 ~/.x-harness。
// 注意（方案落档）：不影响 agent-delegation 的 agents 目录缺省链（那条链读 X_HARNESS_AGENTS_DIRS）。

import { homedir } from "node:os";
import { join } from "node:path";

export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.X_HARNESS_HOME?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".x-harness");
}

/** providers.json 位置（docs/CLI.md §2.2） */
export function providersPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(env), "providers.json");
}

/** 会话存储根（docs/CLI.md §2.1 --session-dir 缺省） */
export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(env), "sessions");
}
