import type { BashParse, ParsedCommand } from "./ast.ts";
import { INTERPRETER_FAMILY } from "./injection.ts";
import { SUDO_LIKE } from "./hard-deny.ts";

export { isInterpreterName } from "./injection.ts";

export type Reparse = (src: string) => BashParse;

export function basenameOf(word: string): string {
  if (!word.includes("/")) return word;
  return word.split("/").filter(Boolean).pop() ?? word;
}

const RUNNERS: ReadonlySet<string> = new Set([
  "setsid", "exec", "command", "builtin", "timeout", "nice", "stdbuf", "watch",
  "coproc", "script", "strace", "ltrace", "valgrind",
]);

const EXECUTOR_WORDS: ReadonlySet<string> = new Set([
  "source", ".", "awk", "gawk", "mawk", "ssh", "docker", "podman", "kubectl", "osascript",
]);

const BASH_FAMILY: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

const BUN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run", "test", "install", "add", "remove", "update", "upgrade", "link", "unlink", "publish",
  "audit", "outdated", "pm", "init", "create", "build", "deploy", "patch",
]);

const JUNK: ReadonlySet<string> = new Set(["{", "}", "then", "fi", "do", "done", "else", "elif", "esac", "in", "!"]);

const DYNAMIC_TEXT = /[$`*?[]/;

export function applyCommandPolicy(commands: readonly ParsedCommand[], reparse: Reparse): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  const queue = [...commands];
  while (queue.length > 0) {
    const cmd = queue.shift();
    if (cmd !== undefined) out.push(policyOf(cmd, reparse, queue));
  }
  return out;
}

function policyOf(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  if (cmd.argv.length === 0) return cmd;
  const base = basenameOf(cmd.argv[0] ?? "");
  const strip = stripWrapper(cmd.argv, base);
  if (strip.kind === "stripped") {
    const argv = strip.argv;
    if (argv.length === 0 || JUNK.has(argv[0] ?? "")) return { ...cmd, argv, ask: `wrapper:${base}` };
    const envPrefix = strip.envPrefix === true || cmd.assignmentPrefix === true;
    return policyOf({ ...cmd, argv, ...(envPrefix ? { assignmentPrefix: true } : {}) }, reparse, queue);
  }
  if (strip.kind === "fail") return { ...cmd, ask: `wrapper:${base}` };
  if (strip.kind === "opaque") return { ...cmd, opaque: strip.reason };
  return specialPolicy(cmd, base, { reparse, queue });
}

interface PolicyCtx {
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

function specialPolicy(cmd: ParsedCommand, base: string, ctx: PolicyCtx): ParsedCommand {
  if (RUNNERS.has(base)) return runnerPolicy(cmd, base);
  if (isExecutorName(base)) return executorPolicy({ cmd, base, reparse: ctx.reparse, queue: ctx.queue });
  if (base === "eval") return evalPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "trap") return trapPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "git" && cmd.argv[1] === "-c") return { ...cmd, opaque: "opaque-code:git-c" };
  if (base === "xargs" || base === "parallel") return payloadPolicy(cmd, base, ctx.queue);
  if (base === "find") return findExecPolicy(cmd, ctx.queue);
  return cmd;
}

function isExecutorName(base: string): boolean {
  return INTERPRETER_FAMILY.has(base) || /^python\d/.test(base) || EXECUTOR_WORDS.has(base);
}

function runnerPolicy(cmd: ParsedCommand, base: string): ParsedCommand {
  const elevates = cmd.argv.slice(1).some((word) => SUDO_LIKE.has(basenameOf(word)));
  if (elevates) return { ...cmd, ask: "hard-deny:sudo" };
  return { ...cmd, opaque: `opaque-code:${base}` };
}

interface InterpreterCtx {
  readonly cmd: ParsedCommand;
  readonly base: string;
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

function executorPolicy(ctx: InterpreterCtx): ParsedCommand {
  const { cmd, base, reparse, queue } = ctx;
  const opaque = `opaque-code:${base}`;
  if (cmd.assignmentPrefix === true) return { ...cmd, opaque };
  if (cmd.stdinFed === true || cmd.redirects.some((r) => r.face === "input")) return { ...cmd, opaque };
  if (cmd.argv.length === 1) return cmd;
  if (base === "bun" && BUN_SUBCOMMANDS.has(cmd.argv[1] ?? "")) return cmd;
  const payload = BASH_FAMILY.has(base) ? cPayloadOf(cmd.argv) : null;
  if (payload === null) return { ...cmd, opaque };
  if (payload === "") return { ...cmd, ask: opaque };
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, ask: opaque };
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
  queue.push(...reparsed.commands);
  return cmd;
}

function cPayloadOf(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    if (word === undefined || word === "--" || !/^-[a-zA-Z]+$/.test(word)) break;
    if (!word.includes("c")) continue;
    const payload = argv[i + 1];
    return payload === undefined ? "" : payload;
  }
  return null;
}

type StripOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "stripped"; readonly argv: readonly string[]; readonly envPrefix?: boolean }
  | { readonly kind: "fail" }
  | { readonly kind: "opaque"; readonly reason: string };

const STRIP_NONE: StripOutcome = { kind: "none" };

function stripWrapper(argv: readonly string[], base: string): StripOutcome {
  if (base === "env") return stripEnv(argv);
  if (base === "nohup") return { kind: "stripped", argv: argv.slice(1) };
  if (base === "time") {
    const rest = argv.slice(1);
    return { kind: "stripped", argv: rest[0] === "-p" ? rest.slice(1) : rest };
  }
  return STRIP_NONE;
}

function stripEnv(argv: readonly string[]): StripOutcome {
  let at = 1;
  let envPrefix = false;
  for (;;) {
    const word = argv[at];
    if (word === undefined || word === "--") {
      at += word !== undefined ? 1 : 0;
      break;
    }
    if (word === "-i") {
      at += 1;
      continue;
    }
    if (word === "-u") {
      at += 2;
      continue;
    }
    if (word === "-S" || word === "--split-string") return { kind: "opaque", reason: "opaque-code:env" };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1;
      envPrefix = true;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  return envPrefix ? { kind: "stripped", argv: argv.slice(at), envPrefix } : { kind: "stripped", argv: argv.slice(at) };
}

function evalPolicy(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  const payload = cmd.argv[1];
  if (payload === undefined) return cmd;
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, injection: cmd.injection ?? "eval" };
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
  queue.push(...reparsed.commands);
  return cmd;
}

function trapPolicy(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  const payload = cmd.argv[1] === "--" ? cmd.argv[2] : cmd.argv[1];
  if (payload === undefined) return cmd;
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, injection: "eval" };
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
  queue.push(...reparsed.commands);
  return cmd;
}

interface PayloadScan {
  readonly rest: readonly string[] | undefined;
}

function scanCarrierFlags(argv: readonly string[], base: string): PayloadScan {
  const noArgShorts: ReadonlySet<string> = base === "xargs" ? new Set(["0", "r", "t", "x"]) : new Set<string>();
  const argShorts: ReadonlySet<string> = base === "xargs" ? new Set(["I", "d", "n", "P", "E", "s", "a", "L", "l"]) : new Set(["j", "J"]);
  const longs: ReadonlySet<string> =
    base === "xargs"
      ? new Set(["--no-run-if-empty", "--verbose", "--exit", "--null", "--replace", "--max-args", "--max-procs", "--arg-file", "--delimiter"])
      : new Set(["--jobs", "--keep-order", "--line-buffer", "--dry-run", "--tag", "--ungroup", "--halt"]);
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    if (word === "--") {
      at += 1;
      break;
    }
    if (longs.has(word)) {
      at += 1;
      continue;
    }
    if (/^--[a-z-]+=/.test(word)) {
      at += 1;
      continue;
    }
    const short = /^-([a-zA-Z])(.*)$/.exec(word);
    if (short !== null) {
      const step = shortFlagStep(short, noArgShorts, argShorts);
      if (step === undefined) return { rest: undefined };
      at += step;
      continue;
    }
    if (word.startsWith("-")) return { rest: undefined };
    break;
  }
  return { rest: argv.slice(at) };
}

function shortFlagStep(match: RegExpExecArray, noArgShorts: ReadonlySet<string>, argShorts: ReadonlySet<string>): number | undefined {
  const flag = match[1];
  const attached = match[2] ?? "";
  if (flag === undefined) return undefined;
  if (noArgShorts.has(flag)) return attached === "" ? 1 : undefined;
  if (!argShorts.has(flag)) return undefined;
  return attached === "" ? 2 : 1;
}

function payloadPolicy(cmd: ParsedCommand, base: string, queue: ParsedCommand[]): ParsedCommand {
  const scan = scanCarrierFlags(cmd.argv, base);
  if (scan.rest === undefined) return { ...cmd, ask: `wrapper:${base}` };
  if (scan.rest.length === 0) return { ...cmd, injection: cmd.injection ?? "xargs-shell" };
  queue.push({
    argv: scan.rest,
    dynamic: scan.rest.some((word) => DYNAMIC_TEXT.test(word)),
    redirects: [],
    raw: scan.rest.join(" "),
    stdinFed: true,
  });
  return cmd;
}

function findExecPolicy(cmd: ParsedCommand, queue: ParsedCommand[]): ParsedCommand {
  let injection: ParsedCommand["injection"];
  for (let i = 1; i < cmd.argv.length; i++) {
    const word = cmd.argv[i];
    if (word !== "-exec" && word !== "-execdir" && word !== "-ok" && word !== "-okdir") continue;
    const payload: string[] = [];
    let at = i + 1;
    while (at < cmd.argv.length) {
      const w = cmd.argv[at];
      if (w === ";" || w === "+") break;
      if (w !== undefined) payload.push(w);
      at += 1;
    }
    i = at;
    if (payload.length === 0) {
      injection = "find-exec";
      continue;
    }
    queue.push({ argv: payload, dynamic: payload.some((w) => DYNAMIC_TEXT.test(w)), redirects: [], raw: payload.join(" "), stdinFed: true });
  }
  return injection === undefined ? cmd : { ...cmd, injection };
}
