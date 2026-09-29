import { homedir } from "node:os";
import { join } from "node:path";

export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.X_HARNESS_HOME?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".x-harness");
}

export function providersPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(env), "providers.json");
}

export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(env), "sessions");
}
