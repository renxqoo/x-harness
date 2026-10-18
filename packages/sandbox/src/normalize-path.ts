import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const STANDARD_BIN_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/bin",
  "/sbin",
];

const HOME_BIN_DIRS: readonly string[] = ["~/.bun/bin", "~/.local/bin", "~/bin"];

export interface NormalizePathInput {
  readonly path: string | undefined;
  readonly home?: string;
  readonly extraDirs?: readonly string[];
  readonly isDir?: (p: string) => boolean;
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return resolve(p);
}

export function normalizePath(input: NormalizePathInput): string {
  const home = input.home ?? homedir();
  const isDir = input.isDir ?? defaultIsDir;
  const existing = (dirs: readonly string[]): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const dir of dirs) {
      if (dir === "") continue;
      const resolved = expandHome(dir, home);
      if (seen.has(resolved) || !isDir(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
    return out;
  };
  const fromInput = (input.path ?? "").split(":").map((entry) => entry.trim());
  const merged = existing([
    ...fromInput,
    ...(input.extraDirs ?? []),
    ...HOME_BIN_DIRS.map((d) => expandHome(d, home)),
    ...STANDARD_BIN_DIRS,
  ]);
  if (merged.length === 0) return input.path ?? "";
  return merged.join(":");
}
