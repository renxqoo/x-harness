// 硬拒底线（docs/EXEC-ENV.md §14.3）：恒 ask、会话授权永不放行（NEVER_MEMORIZE——硬拒先于
// allow 规则）。入参是 AST 词面重构 + 包装器剥离后的干净 argv：引号拼接/反斜杠/级联
// （sud''o、s\udo、"su"do）在 ast 层已消、env 前缀在 wrappers 层已剥——这里只做 basename
// 归一 + 形态判定。管道入 shell 由 AST pipeline 结构执法（injection），不在此。

export type HardDenyKind = "rm-rf-root" | "sudo" | "force-push" | "chmod-777";

/** 提权/密码类——auto 档硬拒底线、full 档唯一直接 deny 面（裁决⑤）、运行器提权词扫描共用。
 *  2026-09-29 红队扩表：pkexec/sudoedit/gsudo/please 同为提权入口（原三词表漏——
 *  full 档 pkexec id 曾 allow）；
 *  与 ELEVATION_TEXT 词面兜底（facts.ts 全段 argv 扫描）配合构成提权面双保险 */
export const SUDO_LIKE: ReadonlySet<string> = new Set(["sudo", "doas", "su", "pkexec", "sudoedit", "gsudo"]);
// please 工具不入词面兜底（英语常用词——误伤面大于收益；SUDO_LIKE 首词命中仍拦裸 please 形态）

/** 提权词面兜底正则（词内扫描——argv 任意词含提权词即命中：载荷形 `watch 'sudo id'`、
 *  git -c 值、env -S 载荷、$'su'do 拼接词。basename 归一在词首提取；darwin 大小写
 *  归一（i 旗——Sudo/suDO 变体同拒） */
export const ELEVATION_TEXT: RegExp = /\b(?:sudo|doas|pkexec|sudoedit|gsudo)\b|(?<![\w-])su(?![\w-])/i;

/** basename 归一（/usr/bin/sudo → sudo；纯根 "/" 保留；darwin 大小写归一——Sudo/SUDO 变体同拒） */
function basenameOf(word: string): string {
  if (!word.includes("/")) return foldCase(word);
  return foldCase(word.split("/").filter(Boolean).pop() ?? "/");
}

/** darwin 大小写归一（P0-2：APFS 不敏感——deny 面从严；与 glob.CASE_FOLD 同源语义） */
function foldCase(word: string): string {
  return process.platform === "darwin" ? word.toLowerCase() : word;
}

/** SUDO_LIKE 大小写归一判定（darwin） */
export function isSudoLike(word: string): boolean {
  return SUDO_LIKE.has(foldCase(word));
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
  if (argv0 === "git" && forcePush(argv)) return "force-push";
  if (argv0 === "chmod" && chmod777(argv)) return "chmod-777";
  return undefined;
}
