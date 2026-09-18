// 硬拒底线（docs/EXEC-ENV.md §5 管线第 2 步）：恒 ask、会话授权永不放行（NEVER_MEMORIZE——
// 硬拒检查先于一切规则，allow 规则无法越过）。归一化吃掉 15 形逃脱：拆 flag（-r -f）、引号拼接
// （sud''o）、反斜杠（s\udo）、绝对路径（/usr/bin/sudo）、env 前缀赋值、换行前缀（段拆已处理）、
// 子壳（段拆已处理）、命令替换（注入检测已先行 ask）。

export type HardDenyKind = "rm-rf-root" | "sudo" | "force-push" | "net-pipe-shell" | "chmod-777";

const SUDO_LIKE = new Set(["sudo", "doas"]);

/** 词元归一化：绝对路径取 basename（纯根 "/" 保留为 "/"）；引号/反斜杠拼接已在词法层剥除 */
function normalizeWords(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of words) {
    const base = raw.includes("/") ? (raw.split("/").filter(Boolean).pop() ?? "/") : raw;
    if (base !== "") out.push(base);
  }
  // env 前缀剥离：env [-i|-u X|--] [VAR=x…] cmd → cmd（flag 与赋值都属 env 自身参数）
  let at = 0;
  if (out[0] === "env") {
    at = 1;
    for (;;) {
      const word = out[at];
      if (word === undefined) break;
      if (word === "-i" || word === "--") {
        at += 1;
        continue;
      }
      if (word === "-u") {
        at += 2; // -u USER 两词
        continue;
      }
      if (/^\w+=/.test(word)) {
        at += 1;
        continue;
      }
      break;
    }
  }
  return out.slice(at);
}

/** flag 归一化：-rf/-fr/-r/-f/--recursive/--force 拆成集合 */
function flagsOf(words: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (const word of words.slice(1)) {
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

function targetOf(words: readonly string[]): string | undefined {
  return words.slice(1).find((word) => !word.startsWith("-"));
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

function netPipeShell(argv: readonly string[], rawText: string): boolean {
  const argv0 = argv[0];
  if (argv0 !== "curl" && argv0 !== "wget") return false;
  return rawText.includes("|") && /\|\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|a)?sh\b/.test(rawText);
}

export function hardDeny(words: readonly string[], rawText: string): HardDenyKind | undefined {
  const argv = normalizeWords(words);
  const argv0 = argv[0];
  if (argv0 === undefined) return undefined;
  if (SUDO_LIKE.has(argv0)) return "sudo";
  if (argv0 === "rm" && rmRfRoot(argv)) return "rm-rf-root"; // 绝对路径/家目录为目标的双 flag 删除
  if (forcePush(argv)) return "force-push";
  if (chmod777(argv)) return "chmod-777";
  if (netPipeShell(argv, rawText)) return "net-pipe-shell";
  return undefined;
}
