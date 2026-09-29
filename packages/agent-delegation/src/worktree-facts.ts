const WORKTREES_SEG = "/.git/worktrees/";

export interface WorktreeFacts {
  readonly branch?: string;
  readonly worktreeMain?: string;
}

export function parseWorktreeGitdir(gitFileText: string): { readonly gitdir: string } | undefined {
  const m = /^gitdir: (.+?)\s*$/m.exec(gitFileText);
  const gitdir = m?.[1];
  return gitdir === undefined || gitdir === "" ? undefined : { gitdir };
}

export function worktreeMainOfGitdir(gitdir: string): string | undefined {
  const at = gitdir.lastIndexOf(WORKTREES_SEG);
  if (at === -1) return undefined;
  const main = gitdir.slice(0, at);
  return main === "" ? undefined : main;
}

export function branchOfHeadText(headText: string): string | undefined {
  const m = /^ref: refs\/heads\/(.+?)\s*$/m.exec(headText);
  const branch = m?.[1];
  if (branch !== undefined && branch !== "") return branch;
  if (/^[0-9a-f]{40}$/m.test(headText.trim())) return undefined;
  return undefined;
}
