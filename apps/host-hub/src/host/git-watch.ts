import { watch, type FSWatcher } from "node:fs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { branchOfHeadText, parseWorktreeGitdir, worktreeMainOfGitdir } from "@x-harness/agent-delegation";

function refsSignatureOf(commonDir: string): string {
  try {
    const entries = readdirSync(join(commonDir, "refs", "heads"), { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath?: string; path?: string }>;
    const heads = entries
      .filter((e) => !e.name.endsWith(".lock"))
      .map((e) => {
        const full = [e.parentPath ?? e.path, e.name].filter(Boolean).join("/");
        try {
          return `${e.name}:${readFileSync(full, "utf8").trim()}`;
        } catch {
          return e.name;
        }
      })
      .sort()
      .join("|");
    const packed = existsSync(join(commonDir, "packed-refs")) ? readFileSync(join(commonDir, "packed-refs"), "utf8") : "";
    return `${heads}#${String(Buffer.from(packed).length.toString(36))}`;
  } catch {
    return "";
  }
}

export interface GitWatchDirs {
  readonly gitDir: string;
  readonly commonDir: string;
}

export function gitWatchDirsOf(cwd: string): GitWatchDirs | undefined {
  if (cwd === "" || !isAbsolute(cwd)) return undefined;
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
      return { gitDir: gitEntry, commonDir: gitEntry };
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
  if (parsed === undefined) return undefined;
  const main = worktreeMainOfGitdir(parsed.gitdir);
  if (main === undefined) return undefined;
  return { gitDir: parsed.gitdir, commonDir: join(main, ".git") };
}

export function branchAt(gitDir: string): string | undefined {
  try {
    return branchOfHeadText(readFileSync(join(gitDir, "HEAD"), "utf8"));
  } catch {
    return undefined;
  }
}

export interface GitWatchOptions {
  readonly emit: (frame: { threadId: string; cwd: string; branch: string | undefined }) => void;
  readonly liveThreads: () => ReadonlyArray<{ threadId: string; cwd: string }>;
  readonly debounceMs?: number;
  readonly reconcileMs?: number;
  readonly now?: () => number;
  readonly onError?: (message: string) => void;
}

export interface GitWatchService {
  reconcile(): void;
  stop(): void;
}

interface HeldWatch {
  readonly dirs: GitWatchDirs;
  readonly watchers: FSWatcher[];
}

export function createGitWatchService(options: GitWatchOptions): GitWatchService {
  const debounceMs = options.debounceMs ?? 150;
  const held = new Map<string, HeldWatch>();
  const refCount = new Map<string, number>();
  const lastBranch = new Map<string, string | undefined>();
  const pending = new Set<string>();
  const timer = setTimeout(() => {}, 0);
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;
  let retryHandle: ReturnType<typeof setTimeout> | undefined;
  const retryBackoff = new Map<string, number>();
  let stopped = false;

  const anchorKey = (dirs: GitWatchDirs): string => `${dirs.gitDir}\0${dirs.commonDir}`;
  const refsSignatures = new Map<string, string>();

  function closeAnchor(key: string): void {
    const watchGroup = held.get(key);
    if (watchGroup === undefined) return;
    for (const w of watchGroup.watchers) w.close();
    held.delete(key);
    lastBranch.delete(watchGroup.dirs.gitDir);
    pending.delete(watchGroup.dirs.gitDir);
    refsSignatures.delete(watchGroup.dirs.gitDir);
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
    if (stopped || held.has(key) || !refCount.has(key)) return;
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

  function flush(): void {
    const gitDirs = [...pending];
    pending.clear();
    if (gitDirs.length === 0) return;
    const live = options.liveThreads();
    for (const gitDir of gitDirs) {
      const anchor = [...held.values()].find((h) => h.dirs.gitDir === gitDir);
      if (anchor === undefined) continue;
      const branch = branchAt(gitDir);
      const sig = refsSignatureOf(anchor.dirs.commonDir);
      const refsChanged = sig !== refsSignatures.get(gitDir);
      refsSignatures.set(gitDir, sig);
      if (lastBranch.has(gitDir) && lastBranch.get(gitDir) === branch && !refsChanged) continue;
      lastBranch.set(gitDir, branch);
      for (const thread of live) {
        const dirs = gitWatchDirsOf(thread.cwd);
        if (dirs === undefined || dirs.gitDir !== gitDir) continue;
        options.emit({ threadId: thread.threadId, cwd: thread.cwd, branch });
      }
    }
  }

  return {
    reconcile() {
      if (stopped) return;
      const expected = new Map<string, GitWatchDirs>();
      for (const thread of options.liveThreads()) {
        if (!isAbsolute(thread.cwd)) continue;
        const dirs = gitWatchDirsOf(thread.cwd);
        if (dirs === undefined) continue;
        expected.set(anchorKey(dirs), dirs);
      }
      refCount.clear();
      for (const key of expected.keys()) refCount.set(key, 1);
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

export function startGitWatchReconcileLoop(service: GitWatchService, intervalMs = 1_000): () => void {
  const handle = setInterval(() => service.reconcile(), intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
