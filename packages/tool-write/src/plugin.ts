import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createWriteTool } from "./write.ts";

export interface WritePluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env?: ExecEnv;
}

export function createWritePlugin(input: WritePluginInput): Plugin {
  const { gate, observed, env } = input;
  return createToolPlugin({
    name: "tool-write",
    envOption: env,
    gate,
    observed,
    make: (resolved, extraRootsOf, rootOverrideOf) => createWriteTool({ gate, observed, env: resolved, extraRootsOf, rootOverrideOf }),
  });
}
