import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeBaseFacts } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "@x-harness/agent-delegation";

export interface ProbeFactsInput {
  readonly cwd: string;
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
}

export interface GitFacts {
  readonly branch?: string;
  readonly worktreeMain?: string;
}

function isGitWorkdir(cwd: string): boolean {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function findGitEntry(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const entry = join(dir, ".git");
    if (existsSync(entry)) return entry;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function probeGitFacts(cwd: string): GitFacts {
  try {
    if (!statSync(cwd).isDirectory()) return {};
  } catch {
    return {};
  }
  const entry = findGitEntry(cwd);
  if (entry === undefined) return {};
  let isDir: boolean;
  try {
    isDir = statSync(entry).isDirectory();
  } catch {
    return {};
  }
  if (isDir) {
    const head = readTextOrNull(join(entry, "HEAD"));
    const branch = head === null ? undefined : branchOfHeadText(head);
    return branch === undefined ? {} : { branch };
  }
  const gitFile = readTextOrNull(entry);
  if (gitFile === null) return {};
  const parsed = parseWorktreeGitdir(gitFile);
  if (parsed === undefined) return {};
  const head = readTextOrNull(join(parsed.gitdir, "HEAD"));
  const branch = head === null ? undefined : branchOfHeadText(head);
  const main = worktreeMainOfGitdir(parsed.gitdir);
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(main !== undefined ? { worktreeMain: main } : {}),
  };
}

export function probeBaseFacts(input: ProbeFactsInput): BasePromptFacts {
  const git = probeGitFacts(input.cwd);
  return normalizeBaseFacts({
    cwd: input.cwd,
    isGit: isGitWorkdir(input.cwd),
    ...(git.branch !== undefined ? { gitBranch: git.branch } : {}),
    ...(git.worktreeMain !== undefined ? { gitWorktreeMain: git.worktreeMain } : {}),
    platform: input.platform,
    shell: input.env["SHELL"] ?? "",
  });
}
