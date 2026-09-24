// edit 插件装配（docs/EDIT-TOOL.md / docs/TOOLBOX.md §0）：createToolPlugin 包 createEditTool。
// read+write+edit 必须穿引同一 gate+observed 实例（read 侧登记、edit/write 侧校验；
// 漏配症状 FS_NOT_OBSERVED，fail-closed 不假绿）。

import type { Plugin } from "@x-harness/core";
import type { ExecEnv } from "@x-harness/exec-env";
import { createToolPlugin } from "@x-harness/tool-core";
import type { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createEditTool } from "./edit.ts";

export interface EditPluginInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  /** 执行环境（三级解析：工厂参数 > execEnv 服务 > 装配期 throw——fail-closed） */
  readonly env?: ExecEnv;
}

/** edit 使用守则（pi promptGuidelines 四条的 x-harness 等价物）：唯一性/非增量/合并/最小上下文 */
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
