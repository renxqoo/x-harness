// worktree git 事实纯函数（docs/WORKTREE-CONTEXT-AWARENESS.md §1.1/§1.2）：.git file 的
// gitdir 行解析、gitdir → 主仓顶、HEAD 文本 → 分支名。零 IO（读文件归调用方）——
// 字符串表驱动单测的主面；harness probeGitFacts 与本包 worktreeFactsOf/payload
// 共源消费（主仓顶与分支的单一真相）。

/** gitdir 锚段（linked worktree 登记路径的固定中段——<mainRepo>/.git/worktrees/<name>） */
const WORKTREES_SEG = "/.git/worktrees/";

/** worktree 环境事实（键缺席 = 未知/不可判——消费方按在场渲染，不落 null/空串） */
export interface WorktreeFacts {
  /** 分支名（gitdir HEAD 的 ref: refs/heads/<b> 解析）；detached/不可读 → 缺席 */
  readonly branch?: string;
  /** 主仓顶（gitdir 的 /.git/worktrees/ 段前缀）；submodule 形态（无该段）→ 缺席 */
  readonly worktreeMain?: string;
}

/** 解析 .git file 文本（linked worktree 的 gitdir 指针）：`gitdir: <path>` 行 →
 *  { gitdir }；无该行（.git 是目录时读出的内容非此形态/坏文件）→ undefined */
export function parseWorktreeGitdir(gitFileText: string): { readonly gitdir: string } | undefined {
  const m = /^gitdir: (.+?)\s*$/m.exec(gitFileText);
  const gitdir = m?.[1];
  return gitdir === undefined || gitdir === "" ? undefined : { gitdir };
}

/** gitdir → 主仓顶：含 /.git/worktrees/ 段 → 段前缀；不含（submodule 形态
 *  `…/.git/modules/x` 等）→ undefined（分支事实独立于归属事实——本函数只裁归属） */
export function worktreeMainOfGitdir(gitdir: string): string | undefined {
  const at = gitdir.lastIndexOf(WORKTREES_SEG);
  if (at === -1) return undefined;
  const main = gitdir.slice(0, at);
  return main === "" ? undefined : main;
}

/** HEAD 文本 → 分支名：`ref: refs/heads/<branch>` → branch（分支名含 `/` 合法）；
 *  detached（40hex）/垃圾 → undefined */
export function branchOfHeadText(headText: string): string | undefined {
  const m = /^ref: refs\/heads\/(.+?)\s*$/m.exec(headText);
  const branch = m?.[1];
  if (branch !== undefined && branch !== "") return branch;
  if (/^[0-9a-f]{40}$/m.test(headText.trim())) return undefined; // detached HEAD
  return undefined;
}
