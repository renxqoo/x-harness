export type HardDenyKind = "rm-rf-root" | "sudo" | "force-push" | "chmod-777";

export const SUDO_LIKE: ReadonlySet<string> = new Set(["sudo", "doas", "su", "pkexec", "sudoedit", "gsudo"]);

export const ELEVATION_TEXT: RegExp = /\b(?:sudo|doas|pkexec|sudoedit|gsudo)\b|(?<![\w-])su(?![\w-])/i;

function basenameOf(word: string): string {
  if (!word.includes("/")) return foldCase(word);
  return foldCase(word.split("/").filter(Boolean).pop() ?? "/");
}

function foldCase(word: string): string {
  return process.platform === "darwin" ? word.toLowerCase() : word;
}

export function isSudoLike(word: string): boolean {
  return SUDO_LIKE.has(foldCase(word));
}

function flagsOf(argv: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (const word of argv.slice(1)) {
    if (word === "--recursive") flags.add("r");
    else if (word === "--force") flags.add("f");
    else if (/^-[a-zA-Z]+$/.test(word)) {
      for (const ch of word.slice(1)) {
        if (ch === "r" || ch === "f") flags.add(ch);
      }
    }
  }
  return flags;
}

function targetOf(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((word) => !word.startsWith("-"));
}

function rmRfRoot(argv: readonly string[]): boolean {
  const flags = flagsOf(argv);
  if (!flags.has("r") || !flags.has("f")) return false;
  const target = targetOf(argv);
  return target !== undefined && (target === "/" || target === "/*" || target.startsWith("/") || target === "~" || target.startsWith("~/"));
}

function forcePush(argv: readonly string[]): boolean {
  if (argv[0] !== "git" || argv[1] !== "push") return false;
  const rest = argv.slice(2).join(" ");
  return /(^|\s)(--force|-f)(\s|$)/.test(rest) || /(^|\s)\+(master|main)\b/.test(rest);
}

function chmod777(argv: readonly string[]): boolean {
  if (argv[0] !== "chmod") return false;
  const rest = argv.slice(1).join(" ");
  return /(^|\s)(-R|--recursive)(\s|$)/.test(rest) && /(^|\s)0?777(\s|$)/.test(rest);
}

export function hardDeny(argv: readonly string[]): HardDenyKind | undefined {
  if (argv.length === 0) return undefined;
  const argv0 = basenameOf(argv[0] ?? "");
  if (SUDO_LIKE.has(argv0)) return "sudo";
  if (argv0 === "rm" && rmRfRoot(argv)) return "rm-rf-root";
  if (argv0 === "git" && forcePush(argv)) return "force-push";
  if (argv0 === "chmod" && chmod777(argv)) return "chmod-777";
  return undefined;
}
