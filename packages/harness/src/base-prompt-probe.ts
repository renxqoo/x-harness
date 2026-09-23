// facts 宿主探测（fs IO 边——与 base-prompt.ts 纯函数面分离）：自 cwd 向上寻 .git、
// platform/shell 自宿主入参取（进程外可注入——测试缝）；归一在 normalizeBaseFacts
// 统一执行。日期已迁边沿注入快照通道（docs/TAIL-SNAPSHOT-CHANNEL.md）。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeBaseFacts } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";

/** 探测入参（宿主进程形态的最小 IO 面） */
export interface ProbeFactsInput {
  readonly cwd: string;
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
}

/** 自 cwd 向上寻 .git（目录或 worktree file 皆算——到文件系统根为止） */
function isGitWorkdir(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** 宿主环境探测 → BasePromptFacts（进程内静态项；SHELL 缺席降级 unknown） */
export function probeBaseFacts(input: ProbeFactsInput): BasePromptFacts {
  return normalizeBaseFacts({
    cwd: input.cwd,
    isGit: isGitWorkdir(input.cwd),
    platform: input.platform,
    shell: input.env["SHELL"] ?? "",
  });
}
