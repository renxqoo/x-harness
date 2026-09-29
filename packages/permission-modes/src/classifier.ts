import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "@x-harness/permission";
import { basenameOfWord, commandReadonly, findCarrierSafe } from "./readonly-verbs.ts";

const WRITE_SAFE_VERBS: ReadonlySet<string> = new Set(["mkdir", "touch", "cp", "mv", "ln", "tee", "install"]);
const WRITE_SAFE_FAMILY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["add", "commit", "checkout", "switch", "restore", "stash", "pull", "fetch", "merge", "rebase", "clone", "init", "cherry-pick", "reset", "clean", "mv", "rm"])],
  ["npm", new Set(["install", "add", "ci", "uninstall", "run", "test", "build", "dev"])],
  ["pnpm", new Set(["install", "add", "ci", "remove", "run", "test", "build", "dev"])],
  ["yarn", new Set(["install", "add", "remove", "run", "test", "build", "dev"])],
  ["bun", new Set(["install", "add", "remove", "run", "test", "build", "dev"])],
  ["cargo", new Set(["build", "test", "check", "run", "fmt", "clippy", "add"])],
  ["go", new Set(["build", "test", "vet", "run", "mod", "fmt"])],
  ["docker", new Set(["build", "pull", "logs", "ps"])],
  ["uv", new Set(["run", "test"])],
]);

const GLOBAL_INSTALL = new Set(["npm", "pnpm", "yarn", "bun", "cargo"]);

function commandWriteSafe(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const base = basenameOfWord(argv[0] ?? "");
  if (GLOBAL_INSTALL.has(base) && argv.some((word) => word === "-g" || word === "--global")) return false;
  if (WRITE_SAFE_VERBS.has(base)) return true;
  const family = WRITE_SAFE_FAMILY.get(base);
  if (family === undefined) return false;
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  return sub !== undefined && family.has(sub);
}

const CARRIER_SKIP: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "find", "parallel", "eval", "trap", "watch",
]);
const TRANSPORT_STRIP: ReadonlySet<string> = new Set([
  "env", "nohup", "timeout", "nice", "stdbuf", "setsid", "command", "builtin", "xargs",
]);

export type CommandClass = "readonly" | "write" | "unclassified";

function stripTransport(argv: readonly string[]): readonly string[] {
  const out = [...argv];
  for (;;) {
    if (out.length === 0) return out;
    const base = basenameOfWord(out[0] ?? "");
    if (TRANSPORT_STRIP.has(base)) {
      out.shift();
      while (out.length > 0) {
        const next = out[0] ?? "";
        if (next.startsWith("-") || /^\d+$/.test(next) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) out.shift();
        else break;
      }
      continue;
    }
    return out;
  }
}

function carrierSkipOf(cmd: ParsedCommand, base: string, opts: { readonly multiSegment: boolean; readonly roots: readonly string[] }): boolean {
  if (!opts.multiSegment || !CARRIER_SKIP.has(base) || cmd.opaque !== undefined) return false;
  return base !== "find" || findCarrierSafe(cmd.argv, (word) => opts.roots.length === 0 || withinRoots(word, opts.roots));
}

function bareCarrier(base: string, argv: readonly string[]): boolean {
  return argv.length === 1 && (CARRIER_SKIP.has(base) || TRANSPORT_STRIP.has(base));
}

export function classifyPipeline(commands: readonly ParsedCommand[], hasOutputRedirect: boolean, roots: readonly string[] = []): CommandClass {
  let sawWrite = false;
  const multiSegment = commands.length > 1;
  for (const cmd of commands) {
    if (cmd.argv.length === 0) continue;
    const base = basenameOfWord(cmd.argv[0] ?? "");
    if (carrierSkipOf(cmd, base, { multiSegment, roots })) continue;
    if (bareCarrier(base, cmd.argv)) continue;
    const effective = stripTransport(cmd.argv);
    if (effective.length === 0) continue;
    const cls = segmentClass(effective, roots);
    if (cls === "unclassified") return "unclassified";
    if (cls === "write") sawWrite = true;
  }
  if (sawWrite || hasOutputRedirect) return "write";
  return "readonly";
}

function findOperandsInRoot(argv: readonly string[], inRoot: (word: string) => boolean): boolean {
  return argv.slice(1).every((word) => {
    if (word.startsWith("-") || word.startsWith("!") || word === "(" || word === ")" || word === "{}") return true;
    const pathLike = word.includes("/") || word === "~" || word.startsWith("~/") || word === "." || word === "..";
    return !pathLike || inRoot(word);
  });
}

function segmentClass(argv: readonly string[], roots: readonly string[]): CommandClass {
  if (argv.length > 0 && basenameOfWord(argv[0] ?? "") === "find" && roots.length > 0 && !findOperandsInRoot(argv, (word) => withinRoots(word, roots))) return "unclassified";
  if (commandReadonly(argv)) return "readonly";
  if (!commandWriteSafe(argv)) return "unclassified";
  const inRoot = (word: string): boolean => roots.length === 0 || withinRoots(word, roots);
  return writeOperandsInRoot(argv, inRoot) ? "write" : "unclassified";
}

function withinRoots(word: string, roots: readonly string[]): boolean {
  let target: string;
  if (word === "~") target = homedir();
  else if (word.startsWith("~/")) target = resolve(homedir(), word.slice(2));
  else target = resolve(roots[0] ?? process.cwd(), word);
  return roots.some((root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`));
}

function writeOperandsInRoot(argv: readonly string[], inRoot: (word: string) => boolean): boolean {
  const valueOf = (word: string): string | undefined => {
    if (!word.startsWith("-")) return word;
    const eq = word.indexOf("=");
    return eq === -1 ? undefined : word.slice(eq + 1);
  };
  return argv.slice(1).every((word) => {
    const value = valueOf(word);
    if (value === undefined) return true;
    if (value === "") return true;
    const pathLike = value.includes("/") || value === "~" || value.startsWith("~/") || value === ".." || value === ".";
    return !pathLike || inRoot(value);
  });
}
