export type InjectionKind = "command-substitution" | "net-pipe-shell" | "find-exec" | "xargs-shell" | "eval" | "base64-shell";


export const INTERPRETER_FAMILY: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "ash", "node", "bun", "deno", "python", "python3", "ruby", "perl", "php",
]);

export function isInterpreterName(base: string): boolean {
  return INTERPRETER_FAMILY.has(base) || /^python\d/.test(base);
}

export const PIPE_FETCHERS: ReadonlyMap<string, InjectionKind> = new Map([
  ["curl", "net-pipe-shell"],
  ["wget", "net-pipe-shell"],
  ["fetch", "net-pipe-shell"],
  ["base64", "base64-shell"],
]);
