import type { WorktreeFacts } from "./worktree-facts.ts";

export interface WorktreeEnvInput {
  readonly path: string;
  readonly facts: WorktreeFacts | undefined;
}

export function appendWorktreeEnv(basePrompt: string, input: WorktreeEnvInput): string {
  const block = worktreeEnvBlock(input);
  if (block === "") return basePrompt;
  return basePrompt === "" ? block : `${basePrompt}\n\n${block}`;
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

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
