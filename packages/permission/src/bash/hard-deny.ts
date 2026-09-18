// 硬拒底线（docs/EXEC-ENV.md §14.3）：恒 ask、会话授权永不放行（NEVER_MEMORIZE——硬拒先于
// allow 规则）。入参是 AST 词面重构 + 包装器剥离后的干净 argv：引号拼接/反斜杠/级联
// （sud''o、s\udo、"su"do）在 ast 层已消、env 前缀在 wrappers 层已剥——这里只做 basename
// 归一 + 形态判定。管道入 shell 由 AST pipeline 结构执法（injection），不在此。

export type HardDenyKind = "rm-rf-root" | "sudo" | "force-push" | "chmod-777";

const SUDO_LIKE: ReadonlySet<string> = new Set(["sudo", "doas"]);

/** basename 归一（/usr/bin/sudo → sudo；纯根 "/" 保留） */
function basenameOf(word: string): string {
  if (!word.includes("/")) return word;
  return word.split("/").filter(Boolean).pop() ?? "/";
}

/** flag 归一化：-rf/-fr/-r/-f/--recursive/--force 拆成集合 */
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
  if (argv0 === "rm" && rmRfRoot(argv)) return "rm-rf-root"; // 绝对路径/家目录为目标的双 flag 删除
  if (forcePush(argv)) return "force-push";
  if (chmod777(argv)) return "chmod-777";
  return undefined;
}
