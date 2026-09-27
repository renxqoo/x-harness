// worktree 子会话环境块（docs/WORKTREE-CONTEXT-AWARENESS.md §1.4 Track N）：named 子
// 的 options.systemPrompt 静态短路 prompt.assemble（step.ts），环境事实拼在类型正文
// 尾部。纯函数——spawn（WorktreePlan）与 revive（预解析事实）两路共源。

import type { WorktreeFacts } from "./worktree-facts.ts";

export interface WorktreeEnvInput {
  /** worktree 根（子会话的工作区——bash/PathGate 执行面同值） */
  readonly path: string;
  /** git 事实（branch/worktreeMain 各自缺席即省略行——键缺席=未知） */
  readonly facts: WorktreeFacts | undefined;
}

/** 拼装 named 子 systemPrompt：类型正文 + 环境块（正文空则块独立成文）。 */
export function appendWorktreeEnv(basePrompt: string, input: WorktreeEnvInput): string {
  const block = worktreeEnvBlock(input);
  if (block === "") return basePrompt;
  return basePrompt === "" ? block : `${basePrompt}\n\n${block}`;
}

/** 单行归一（与 harness base-prompt inline 同款口径）：压掉换行——环境值不得伪造
 *  新段落标题（路径可含换行的文件名/档案字段是注入面——红测回归锚）。 */
function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** 环境块全文（facts 双缺席仍渲染目录行——工作区事实不依赖 git 可读性）。
 *  path/branch/worktreeMain 全部单行归一后拼入。 */
export function worktreeEnvBlock(input: WorktreeEnvInput): string {
  const path = inline(input.path);
  const branch = input.facts?.branch !== undefined ? inline(input.facts.branch) : "";
  const main = input.facts?.worktreeMain !== undefined ? inline(input.facts.worktreeMain) : "";
  const lines = [
    "## Environment",
    "",
    "You are running in an isolated git worktree — this is your workspace:",
    `- Working directory: ${path}`,
  ];
  if (branch !== "") lines.push(`- Git branch: ${branch}`);
  lines.push(`- Main repository (read-only reference, outside your sandbox): ${main !== "" ? main : "unknown"}`);
  return lines.join("\n");
}
