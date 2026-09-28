// git 变更监视（docs/GIT-INTERACTION-REDESIGN.md §2.1）：对 live 线程 cwd 的
// gitdir + commonDir 双目录建 fs.watch（HEAD 写落 gitdir、refs 写落 commonDir——
// 建分支不改 HEAD，单目录会让分支菜单永不刷新）；变更 → 150ms 防抖尾沿重读
// HEAD → 逐 live 线程出 git/changed 事件（payload 带 cwd；detached 也发——branch
// 缺席=已分离，防 UI 停留旧分支名）。
//
// 生命周期单一收敛点（审查 F3/F8 裁决）：不按表事件点挂钩——reconcile() 重算期望
// 集合与现持集合做 diff 挂/收；sweep 1s 对账兜底（watcher 静默死/树删重建走退避
// 重挂）。spawning 占位期 cwd 是 raw 串不锚（isAbsolute 门——归一回写后自然进集合）。
//
// 零 git 子进程：gitdir/commonDir 定位纯 fs（.git 目录直取；.git file 经
// parseWorktreeGitdir → gitdir 与 commonDir 推导——linked worktree 的 refs 在
// 主仓 .git，HEAD 在 .git/worktrees/<n>）。

import { watch, type FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "@x-harness/agent-delegation";

/** 监视锚点：gitdir（HEAD 所在）+ commonDir（refs 所在——linked worktree 时两者不同） */
export interface GitWatchDirs {
  readonly gitDir: string;
  readonly commonDir: string;
}

/** 定位 cwd 的监视锚点；非 git/不可判/空串 → undefined（调用方跳过该 cwd）。
 *  空串必须显式拒：resolve("") 会锚到进程 cwd——宿主所在仓的误锚。 */
export function gitWatchDirsOf(cwd: string): GitWatchDirs | undefined {
  if (cwd === "" || !isAbsolute(cwd)) return undefined; // 相对串/spawning raw 不锚
  let dir = resolve(cwd);
  let gitEntry: string | undefined;
  for (;;) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) {
      gitEntry = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  try {
    if (statSync(gitEntry).isDirectory()) {
      return { gitDir: gitEntry, commonDir: gitEntry }; // 主仓本体：两者同位
    }
  } catch {
    return undefined;
  }
  const raw = (() => {
    try {
      return readFileSync(gitEntry, "utf8");
    } catch {
      return null;
    }
  })();
  if (raw === null) return undefined;
  const parsed = parseWorktreeGitdir(raw);
  if (parsed === undefined) return undefined; // 垃圾 .git file
  const main = worktreeMainOfGitdir(parsed.gitdir);
  if (main === undefined) return undefined; // submodule 形态（gitdir 无 worktrees 段）——分支事实另路（probeGitFacts），不监视
  return { gitDir: parsed.gitdir, commonDir: join(main, ".git") };
}

/** HEAD 当前分支（尾沿读取用）；detached/不可读 → undefined（=已分离语义，仍发事件） */
export function branchAt(gitDir: string): string | undefined {
  try {
    return branchOfHeadText(readFileSync(join(gitDir, "HEAD"), "utf8"));
  } catch {
    return undefined;
  }
}

export interface GitWatchOptions {
  /** 事件发射（逐 threadId 一帧——帧契约单值 threadId；payload 带 cwd） */
  readonly emit: (frame: { threadId: string; cwd: string; branch: string | undefined }) => void;
  /** live 线程快照（事件时刻重取——防抖窗内表会漂移） */
  readonly liveThreads: () => ReadonlyArray<{ threadId: string; cwd: string }>;
  /** 防抖窗（缺省 150ms）；对账间隔（缺省 1000ms）；测试注入 now */
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
  readonly now?: () => number;
  readonly onError?: (message: string) => void;
}

export interface GitWatchService {
  /** 表变更后调用：重算期望集合 diff 挂/收（幂等；O(live)） */
  reconcile(): void;
  stop(): void;
}

interface HeldWatch {
  readonly dirs: GitWatchDirs;
  readonly watchers: FSWatcher[];
}

/** 建服务。watcher 错误（树删/权限）→ 退避重挂（1s/2s/4s…封顶 30s——对账拍也走这里） */
export function createGitWatchService(options: GitWatchOptions): GitWatchService {
  const debounceMs = options.debounceMs ?? 150;
  const held = new Map<string, HeldWatch>(); // 归一化锚键（gitDir\0commonDir）→ watch 组
  const refCount = new Map<string, number>(); // 锚键 → 期望持有数（diff 依据）
  const lastBranch = new Map<string, string | undefined>(); // gitDir → 上次已发分支（同值抑制）
  const pending = new Set<string>(); // 防抖窗内已脏的 gitDir
  const timer = setTimeout(() => {}, 0); // 保活占位（stop 清）
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;
  let retryHandle: ReturnType<typeof setTimeout> | undefined;
  const retryBackoff = new Map<string, number>();
  let stopped = false;

  const anchorKey = (dirs: GitWatchDirs): string => `${dirs.gitDir}\0${dirs.commonDir}`;

  function closeAnchor(key: string): void {
    const watchGroup = held.get(key);
    if (watchGroup === undefined) return;
    for (const w of watchGroup.watchers) w.close();
    held.delete(key);
    lastBranch.delete(watchGroup.dirs.gitDir);
    pending.delete(watchGroup.dirs.gitDir);
  }

  function openAnchor(key: string, dirs: GitWatchDirs): void {
    if (stopped || held.has(key)) return;
    const watchers: FSWatcher[] = [];
    for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
      try {
        const w = watch(dir, { persistent: false }, () => {
          pending.add(dirs.gitDir);
          scheduleFlush();
        });
        w.on("error", () => {
          // 树删/权限/平台错：关组退避重挂（对账拍也兜——双保险）
          options.onError?.(`git watch error: ${dir}`);
          closeAnchor(anchorKey(dirs));
          scheduleRetry(anchorKey(dirs), dirs);
        });
        watchers.push(w);
      } catch {
        options.onError?.(`git watch open failed: ${dir}`);
        scheduleRetry(key, dirs);
        return;
      }
    }
    held.set(key, { dirs, watchers });
    retryBackoff.delete(key);
  }

  function scheduleRetry(key: string, dirs: GitWatchDirs): void {
    if (stopped || held.has(key) || !refCount.has(key)) return; // 已不期望——放掉
    const backoff = Math.min((retryBackoff.get(key) ?? 500) * 2, 30_000);
    retryBackoff.set(key, backoff);
    retryHandle = setTimeout(() => {
      if (refCount.has(key) && !held.has(key)) openAnchor(key, dirs);
    }, backoff);
  }

  function scheduleFlush(): void {
    if (debounceHandle !== undefined || stopped) return;
    debounceHandle = setTimeout(() => {
      debounceHandle = undefined;
      flush();
    }, debounceMs);
  }

  /** 防抖尾沿：重读 HEAD 取真值 + 当时 live 快照 fan-out + 同值抑制 */
  function flush(): void {
    const gitDirs = [...pending];
    pending.clear();
    if (gitDirs.length === 0) return;
    const live = options.liveThreads();
    for (const gitDir of gitDirs) {
      const anchor = [...held.values()].find((h) => h.dirs.gitDir === gitDir);
      if (anchor === undefined) continue;
      const branch = branchAt(gitDir);
      if (lastBranch.has(gitDir) && lastBranch.get(gitDir) === branch) continue; // 同值抑制（A→B→A 不发）
      lastBranch.set(gitDir, branch);
      for (const thread of live) {
        const dirs = gitWatchDirsOf(thread.cwd); // 尾沿重定位（cwd 可能已变）
        if (dirs === undefined || dirs.gitDir !== gitDir) continue;
        options.emit({ threadId: thread.threadId, cwd: thread.cwd, branch });
      }
    }
  }

  return {
    reconcile() {
      if (stopped) return;
      // 期望集合：live 线程 cwd 的锚点（isAbsolute 门——spawning raw 串跳过）
      const expected = new Map<string, GitWatchDirs>();
      for (const thread of options.liveThreads()) {
        if (!isAbsolute(thread.cwd)) continue;
        const dirs = gitWatchDirsOf(thread.cwd);
        if (dirs === undefined) continue;
        expected.set(anchorKey(dirs), dirs);
      }
      refCount.clear();
      for (const key of expected.keys()) refCount.set(key, 1);
      // diff：多的收、少的挂（先收集目标再收——避免遍历中变异键集）
      const stale: string[] = [];
      for (const key of held.keys()) {
        if (!expected.has(key)) stale.push(key);
      }
      for (const key of stale) closeAnchor(key);
      for (const [key, dirs] of expected) {
        if (!held.has(key)) openAnchor(key, dirs);
      }
    },
    stop() {
      stopped = true;
      if (debounceHandle !== undefined) clearTimeout(debounceHandle);
      if (retryHandle !== undefined) clearTimeout(retryHandle);
      clearTimeout(timer);
      const keys = [...held.keys()];
      for (const key of keys) closeAnchor(key);
      refCount.clear();
    },
  };
}

/** 对账循环（1s reconcile——watcher 静默死/漏挂的兜底；返回停机函数） */
export function startGitWatchReconcileLoop(service: GitWatchService, intervalMs = 1_000): () => void {
  const handle = setInterval(() => service.reconcile(), intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
