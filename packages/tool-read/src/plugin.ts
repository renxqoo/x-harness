import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createReadTool } from "./read.ts";

export interface ReadPluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env?: ExecEnv;
  readonly systemRoots?: readonly string[];
}

export function createReadPlugin(input: ReadPluginInput): Plugin {
  const { gate, observed, env, systemRoots } = input;
  return createToolPlugin({
    name: "tool-read",
    envOption: env,
    gate,
    observed,
    ...(systemRoots !== undefined ? { systemRoots } : {}),
    make: (resolved, extraRootsOf, rootOverrideOf) => createReadTool({ gate, observed, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
