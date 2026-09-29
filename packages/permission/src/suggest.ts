import type { ParsedCommand } from "./bash/ast.ts";

import { INTERPRETER_FAMILY } from "./bash/injection.ts";
import { SUDO_LIKE } from "./bash/hard-deny.ts";

const NO_GENERALIZE_EXTRA: ReadonlySet<string> = new Set([
  "env", "nohup", "time", "exec", "awk", "sed", "xargs", "eval", "osascript", "source", ".",
]);
const NO_GENERALIZE: ReadonlySet<string> = new Set([...INTERPRETER_FAMILY, ...SUDO_LIKE, ...NO_GENERALIZE_EXTRA]);

function rawHeadBanned(cmd: ParsedCommand): boolean {
  const head = basenameOf((cmd.raw ?? "").trim().split(/\s+/)[0] ?? "");
  return head !== "" && NO_GENERALIZE.has(head);
}

function basenameOf(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

export function suggestRule(parsed: { readonly commands: readonly ParsedCommand[] }): string | undefined {
  if (parsed.commands.length !== 1) return undefined;
  const cmd = parsed.commands[0];
  if (cmd === undefined || cmd.argv.length === 0) return undefined;
  if (cmd.dynamic || cmd.injection !== undefined || cmd.ask !== undefined || cmd.opaque !== undefined) return undefined;
  if (rawHeadBanned(cmd)) return undefined;
  const base = basenameOf(cmd.argv[0] ?? "");
  if (NO_GENERALIZE.has(base)) return undefined;
  if (cmd.argv[0] !== base) return undefined;
  const sub = cmd.argv[1];
  if (sub !== undefined && !sub.startsWith("-") && !sub.includes("/")) return `Danger(${base} ${sub}:*):allow`;
  return `Danger(${base}:*):allow`;
}

export function exactRule(command: string): string | undefined {
  if (/\s:?\*/.test(command) || command.includes(":*")) return undefined;
  return `Danger(${command}):allow`;
}
