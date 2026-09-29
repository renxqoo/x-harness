import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "./bash/ast.ts";
import { globMatch } from "./rules/glob.ts";

export function protectGlobMatch(pattern: string, path: string, root: string): boolean {
  if (globMatch(pattern, path, root)) return true;
  const dirPattern = pattern.endsWith("/") ? `${pattern}**` : `${pattern}/**`;
  return globMatch(dirPattern, path, root);
}

function candidatePaths(word: string, root: string): string[] {
  if (word === "~") return [homedir()];
  if (word.startsWith("~/")) return [resolve(homedir(), word.slice(2))];
  if (/^~[A-Za-z0-9_.-]/.test(word)) return [];
  if (word.startsWith("/")) return [resolve(word)];
  return [resolve(root, word)];
}

export interface DenyTables {
  readonly protectedWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly denyReadOutside?: readonly string[];
  readonly allowRoots?: readonly string[];
}

export function denyReadHit(tables: DenyTables, path: string, root: string): string | undefined {
  const hit = tables.denyRead.find((pattern: string) => globMatch(pattern, path, root));
  if (hit !== undefined) return hit;
  const conditional = tables.denyReadOutside?.find((pattern: string) => globMatch(pattern, path, root));
  if (conditional === undefined) return undefined;
  if (tables.allowRoots !== undefined && tables.allowRoots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`))) return undefined;
  return conditional;
}

export function cwdAfter(cmd: ParsedCommand, cwd: string): string {
  if (cmd.argv[0] !== "cd" || cmd.argv.length < 2) return cwd;
  const target = cmd.argv[1] ?? "";
  if (target === "") return cwd;
  if (/[$`*?[]/.test(target)) return cwd;
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (target.startsWith("/")) return resolve(target);
  return resolve(cwd, target);
}

function commandSensitiveHit(cmd: ParsedCommand, root: string, tables: DenyTables): { readonly kind: "deny-read" | "protect-write"; readonly pattern: string } | undefined {
  const words: string[] = cmd.argv.slice(1);
  for (const redirect of cmd.redirects) {
    if (redirect.target !== undefined && redirect.target !== "/dev/null") words.push(redirect.target);
  }
  for (const raw of words) {
    if (raw === "") continue;
    let word = raw;
    if (word.startsWith("-")) {
      const body = word.replace(/^-+/, "");
      const eq = body.indexOf("=");
      if (eq === -1) continue;
      word = body.slice(eq + 1);
    }
    if (word.startsWith("@")) word = word.slice(1);
    if (word === "") continue;
    if (/^~[A-Za-z0-9_.-]/.test(word)) return { kind: "deny-read", pattern: word };
    for (const path of candidatePaths(word, root)) {
      const readHit = denyReadHit(tables, path, root);
      if (readHit !== undefined) return { kind: "deny-read", pattern: readHit };
      const writeHit = [...tables.denyWrite, ...tables.protectedWrite].find((pattern: string) => protectGlobMatch(pattern, path, root));
      if (writeHit !== undefined) return { kind: "protect-write", pattern: writeHit };
    }
  }
  return undefined;
}

export function argvSensitiveHit(
  commands: readonly ParsedCommand[],
  root: string,
  tables: DenyTables = { protectedWrite: [], denyRead: [], denyWrite: [] },
): { readonly kind: "deny-read" | "protect-write"; readonly pattern: string } | undefined {
  let cwd = root;
  for (const cmd of commands) {
    const hit = commandSensitiveHit(cmd, cwd, tables);
    if (hit !== undefined) return hit;
    cwd = cwdAfter(cmd, cwd);
  }
  return undefined;
}
