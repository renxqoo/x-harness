import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { PathGate } from "@x-harness/tool-core";
import { createGrepTool } from "./grep.ts";

export interface GrepPluginInput {
  readonly gate: PathGate;
  readonly env?: ExecEnv;
  readonly rgPath?: string;
  readonly rgBinDir?: string;
  readonly systemRoots?: readonly string[];
}

export function createGrepPlugin(input: GrepPluginInput): Plugin {
  const { gate, env, rgPath, rgBinDir, systemRoots } = input;
  return createToolPlugin({
    name: "tool-grep",
    envOption: env,
    gate,
    ...(systemRoots !== undefined ? { systemRoots } : {}),
    make: (resolved, extraRootsOf, rootOverrideOf) => createGrepTool({ gate, options: { rgPath, rgBinDir }, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
