// facts 宿主探测（fs IO 边——与 base-prompt.ts 纯函数面分离）：自 cwd 向上寻 .git、
// platform/shell 自宿主入参取（进程外可注入——测试缝）；归一在 normalizeBaseFacts
// 统一执行。日期已迁边沿注入快照通道（docs/TAIL-SNAPSHOT-CHANNEL.md）。
// git 事实（docs/WORKTREE-CONTEXT-AWARENESS §1.1）：纯 fs 读 .git/HEAD（无 git 子
// 进程——热路径 thread/list 现算；解析纯函数归 @x-harness/agent-delegation
// worktree-facts，主仓顶与分支的单一真相共源）。

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeBaseFacts } from "./base-prompt.ts";
import type { BasePromptFacts } from "./base-prompt.ts";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "@x-harness/agent-delegation";

/** 探测入参（宿主进程形态的最小 IO 面） */
export interface ProbeFactsInput {
  readonly cwd: string;
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
}

/** git 事实（键缺席 = 未知/不可判——消费方按在场渲染，不落 null/空串） */
export interface GitFacts {
  readonly branch?: string;
  readonly worktreeMain?: string;
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

/** 自 cwd 向上寻 .git 路径（目录或 file）；缺席 → undefined（游走与 isGitWorkdir 同源） */
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

/** 读文本文件（同步、小文件）；失败 → null（降级不判——垃圾输入原则） */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** git 事实探测（docs/WORKTREE-CONTEXT-AWARENESS §1.1 探测序）：
 *  0. cwd 存在性前置（statSync）——不存在返回 {}（D7：防向上游走命中无关祖先仓——
 *     worktree 被删后 home 目录 dotfiles 仓误显示）；
 *  1. 上寻 .git；
 *  2. 目录（主仓本体）→ 读 <.git>/HEAD（ref 行 → branch；detached → 省略）；
 *  3. file（linked worktree）→ parseWorktreeGitdir → branch 恒读 <gitdir>/HEAD
 *     （分支事实独立于归属）；worktreeMain = gitdir 的 worktrees 段前缀
 *     （submodule 形态无段 → 省略）；
 *  4. 任一步 IO 失败/垃圾 → 对应键省略。 */
export function probeGitFacts(cwd: string): GitFacts {
  try {
    if (!statSync(cwd).isDirectory()) return {};
  } catch {
    return {}; // cwd 不存在——双键省略（D7 存在性前置）
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
  if (parsed === undefined) return {}; // 垃圾 .git file
  const head = readTextOrNull(join(parsed.gitdir, "HEAD"));
  const branch = head === null ? undefined : branchOfHeadText(head);
  const main = worktreeMainOfGitdir(parsed.gitdir);
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(main !== undefined ? { worktreeMain: main } : {}),
  };
}

/** 宿主环境探测 → BasePromptFacts（进程内静态项；SHELL 缺席降级 unknown） */
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
