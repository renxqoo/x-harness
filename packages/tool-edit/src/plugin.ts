import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createEditTool } from "./edit.ts";

export interface EditPluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env?: ExecEnv;
}

export const editGuidance = `## Edit

- Each edits[].oldText must be unique in the original file. If it is not, include more surrounding lines to make it unique.
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits.
- If two changes touch the same block or nearby lines, merge them into one edit instead of emitting overlapping edits.
- Keep oldText as small as possible while still unique. Do not pad it with large unchanged regions just to connect distant changes.`;

export function createEditPlugin(input: EditPluginInput): Plugin {
  const { gate, observed, env } = input;
  return createToolPlugin({
    name: "tool-edit",
    envOption: env,
    gate,
    observed,
    make: (resolved, extraRootsOf, rootOverrideOf) => createEditTool({ gate, observed, env: resolved, extraRootsOf, rootOverrideOf }),
    guidance: editGuidance,
  });
}
