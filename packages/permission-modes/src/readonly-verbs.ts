const READONLY_VERBS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "which", "file", "stat", "du", "df",
  "ps", "env", "printenv", "whoami", "uname", "date", "id", "hostname", "sort", "uniq",
  "cut", "tr", "diff", "cmp", "tree", "basename", "dirname", "realpath", "readlink",
  "jq", "true", "false", "test", "sleep", "grep", "rg", "find", "column",
  "nl", "tac", "rev", "fmt", "fold", "paste", "join", "comm",
  "seq", "expr", "bc", "cal", "factor", "numfmt",
  "od", "hexdump", "strings",
  "uptime", "who", "w", "groups", "locale", "nproc", "lsof", "netstat",
  "md5sum", "sha1sum", "sha256sum", "git",
]);

export function basenameOfWord(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

function clusterHasFlag(word: string, target: string, valueFlags: ReadonlySet<string>): boolean {
  const chars = word.slice(1);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch === target) return true;
    if (valueFlags.has(ch)) return false;
  }
  return false;
}

function findWriteForms(argv: readonly string[]): boolean {
  return argv.some((word) => word === "-delete" || word.startsWith("-fprint") || word === "-fls" || word.startsWith("-fprintf"));
}

export function findReadonly(argv: readonly string[]): boolean {
  if (findWriteForms(argv)) return false;
  return !argv.some((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
}

export type InRootOf = (word: string) => boolean;

export function findCarrierSafe(argv: readonly string[], inRoot?: InRootOf): boolean {
  const hasExecMarker = argv.some((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
  if (!hasExecMarker || findWriteForms(argv)) return false;
  if (inRoot === undefined) return true;
  return argv.slice(1).every((word) => {
    if (word.startsWith("-") || word.startsWith("!") || word === "(" || word === ")") return true;
    const pathLike = word.includes("/") || word === "~" || word.startsWith("~/") || word === "." || word === "..";
    return !pathLike || inRoot(word);
  });
}

const GIT_READONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "branch", "tag", "remote", "describe", "rev-parse",
  "shortlog", "reflog", "ls-files", "ls-remote", "ls-tree", "cat-file", "blame", "var", "version",
]);

const GIT_BRANCH_MUTATION = { shorts: "dmMcC", longs: ["--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream", "--track", "--no-track"] };
const GIT_TAG_MUTATION = { shorts: "damfsu", longs: ["--delete", "--annotate", "--message", "--file", "--sign", "--local-user", "--force"] };

function clusterHits(word: string, shorts: string): boolean {
  for (const ch of word.slice(1)) {
    if (shorts.includes(ch)) return true;
  }
  return false;
}

function gitMutationHit(words: readonly string[], table: { readonly shorts: string; readonly longs: readonly string[] }): boolean {
  return words.some((word) => {
    if (word.startsWith("--")) return table.longs.some((flag) => word.startsWith(flag));
    return word.startsWith("-") && word !== "-" && clusterHits(word, table.shorts);
  });
}

function gitListOnlyForm(rest: readonly string[], table: { readonly shorts: string; readonly longs: readonly string[] }): boolean {
  if (gitMutationHit(rest, table)) return false;
  const listForm = rest.some((word) => word === "-l" || word.startsWith("--list"));
  if (listForm) return true;
  return rest.every((word) => word.startsWith("-") && word !== "-");
}

function gitReadonly(argv: readonly string[]): boolean {
  if (argv.some((word) => word.startsWith("--output") || word === "--ext-diff")) return false;
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  if (sub === undefined) return true;
  if (!GIT_READONLY_SUBS.has(sub)) return false;
  const rest = argv.slice(argv.indexOf(sub) + 1);
  if (sub === "branch") return gitListOnlyForm(rest, GIT_BRANCH_MUTATION);
  if (sub === "tag") return gitListOnlyForm(rest, GIT_TAG_MUTATION);
  if (sub === "remote") return rest.every((word) => word.startsWith("-") && word !== "-");
  if (sub === "reflog") {
    const first = rest.find((word) => !word.startsWith("-"));
    return first === undefined || first === "show";
  }
  return true;
}

const SORT_VALUE_FLAGS: ReadonlySet<string> = new Set(["k", "t", "T", "S", "o"]);

function sortReadonly(argv: readonly string[]): boolean {
  return !argv.slice(1).some((word) => {
    if (word.startsWith("--compress-program")) return true;
    if (word.startsWith("--o")) return true;
    if (word.startsWith("-") && !word.startsWith("--")) return clusterHasFlag(word, "o", SORT_VALUE_FLAGS);
    return false;
  });
}

function uniqReadonly(argv: readonly string[]): boolean {
  const words = argv.slice(1);
  let operands = 0;
  let flagsDone = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (!flagsDone && word === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && word.startsWith("-") && word !== "-") {
      if (word === "-f" || word === "-s" || word === "-w") i += 1;
      continue;
    }
    flagsDone = true;
    operands += 1;
  }
  return operands <= 1;
}

const TREE_VALUE_FLAGS: ReadonlySet<string> = new Set(["L", "I", "H", "P", "o"]);

function treeReadonly(argv: readonly string[]): boolean {
  return !argv.slice(1).some((word) => {
    if (word.startsWith("--o")) return true;
    if (word.startsWith("-") && !word.startsWith("--")) return clusterHasFlag(word, "o", TREE_VALUE_FLAGS);
    return false;
  });
}

function dateReadonly(argv: readonly string[]): boolean {
  return argv.slice(1).every((word) => word.startsWith("+"));
}

function hostnameReadonly(argv: readonly string[]): boolean {
  return argv.length === 1;
}

function rgReadonly(argv: readonly string[]): boolean {
  return !argv.slice(1).some((word) => word.startsWith("--pre"));
}

const READONLY_EXCEPT: ReadonlyMap<string, (argv: readonly string[]) => boolean> = new Map([
  ["git", gitReadonly],
  ["find", findReadonly],
  ["sort", sortReadonly],
  ["uniq", uniqReadonly],
  ["tree", treeReadonly],
  ["date", dateReadonly],
  ["hostname", hostnameReadonly],
  ["rg", rgReadonly],
]);

export function commandReadonly(argv: readonly string[]): boolean {
  if (argv.length === 0) return true;
  const base = basenameOfWord(argv[0] ?? "");
  if (!READONLY_VERBS.has(base)) return false;
  const except = READONLY_EXCEPT.get(base);
  return except === undefined ? true : except(argv);
}
