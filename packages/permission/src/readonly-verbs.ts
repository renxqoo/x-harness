// 只读动词面（docs/PERMISSION-V2-DESIGN.md §4.4 分类器的白名单真相）：纯 stdout 无副作用
// 观察类动词 + 逐动词写形态例外。铁律：入表动词的任何 argv 形态都不得写文件系统/执行外部
// 程序/变更系统状态——有此类形态的动词要么不入表，要么带例外条件（find/sort/uniq/tree/
// date/hostname 先例）。漏进只读类 = 直通档免确认执行，等于无界破坏面。
// 已接受的有界例外（对抗审查落档）：
// - sort/uniq 溢写时向 $TMPDIR 落临时文件（数据超内存）——有界且不落目标路径，整词降级
//   的打扰成本大于此有界面；
// - git 的外部钩子面（diff.external/GIT_EXTERNAL_DIFF/alias/pager）由 git config 与 env
//   承载，属 env 不清洗已知暴露面（U12 申报面）——argv 词面只收口 --output/--ext-diff 与
//   变更旗；
// - lsof 的 device cache（~/.lsof_*）在部分构建默认落盘——观察类价值保留，注记不逐出；
// - bc 会执行操作数文件里的 bc 程序文本，但 bc 语言无 I/O/落盘语句；dc 有 `!` shell
//   escape，永不入表。

/** 纯只读动词白名单（basename）：无副作用观察类。保守维护——新增动词必须过
 *  对抗审查（写副作用动词混入 = 直通档无界破坏面）；逐旗核对 GNU/BSD 双变体 */
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
// 注：awk/sed（程序体/w 命令=任意代码与任意路径写）、curl/wget（缺省落盘/上传实参）
// 不入只读表——网络与流编辑形态一律走未分类 ask（对抗审查 #2：写副作用动词禁入只读类）。
// pager（man/less/more——man -P 与 MANPAGER/LESSOPEN env 钩子可执行外部程序）、
// xxd（-r 反转写盘）、ss（-K 杀 socket）、ip（子命令变更网络配置）、arch（带操作数即
// 以指定架构执行 prog）、base64（BSD 变体 -o 落盘）同理不入；查看类要进表必须纯 stdout。

export function basenameOfWord(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

/** 短旗簇判定：valueFlags 内的旗自带值（附着或分离——其后不再有独立旗）；
 *  返回簇内是否出现 target 旗（写/执行形态判定用）。`-t o` 的 o 是值不算，`-nro` 的 o 算 */
function clusterHasFlag(word: string, target: string, valueFlags: ReadonlySet<string>): boolean {
  const chars = word.slice(1);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    if (ch === target) return true;
    if (valueFlags.has(ch)) return false;
  }
  return false;
}

/** find 留段写形态：-delete / -fprint*（检索结果落文件）/ -fls（ls -dil 落文件）/ -fprintf* */
function findWriteForms(argv: readonly string[]): boolean {
  return argv.some((word) => word === "-delete" || word.startsWith("-fprint") || word === "-fls" || word.startsWith("-fprintf"));
}

/** find 例外条件：无写形态且无 -exec/-execdir/-ok/-okdir（纯检索） */
export function findReadonly(argv: readonly string[]): boolean {
  if (findWriteForms(argv)) return false;
  return !argv.some((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
}

/** find 载体段豁免资格（多段管线）：-exec 族载荷已提取为独立段，且留段自身无写形态——
 *  -delete/-fprint* 留在段里，不得随载体豁免 */
export function findCarrierSafe(argv: readonly string[]): boolean {
  const hasExecMarker = argv.some((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
  return hasExecMarker && !findWriteForms(argv);
}

/** git 只读子命令（git 家族动词面大——push/push-like 一律不入选） */
const GIT_READONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "branch", "tag", "remote", "describe", "rev-parse",
  "shortlog", "reflog", "ls-files", "ls-remote", "ls-tree", "cat-file", "blame", "var", "version",
]);

/** git 变更旗面（短旗簇字符 + 长旗前缀——getopt_long 无歧义缩写按前缀捕）：
 *  branch 的删/移/复制/上游设置；tag 的删/签注/签名/强制 */
const GIT_BRANCH_MUTATION = { shorts: "dmMcC", longs: ["--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream", "--track", "--no-track"] };
const GIT_TAG_MUTATION = { shorts: "damfsu", longs: ["--delete", "--annotate", "--message", "--file", "--sign", "--local-user", "--force"] };

/** 短旗簇命中：簇内任一字符在 shorts 内（git 短旗多布尔旗——值形附着簇尾也按变更捕） */
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

/** git branch/tag 列表形（`git branch -a`/`git tag -l 'p*'`）才只读；带名称操作数 = 创建/变更 */
function gitListOnlyForm(rest: readonly string[], table: { readonly shorts: string; readonly longs: readonly string[] }): boolean {
  if (gitMutationHit(rest, table)) return false;
  const listForm = rest.some((word) => word === "-l" || word.startsWith("--list"));
  if (listForm) return true;
  return rest.every((word) => word.startsWith("-") && word !== "-");
}

/** git 家族判定：git <sub>（sub 只读且无变更旗/变更操作数）或 git 自身旗标形态（git --version）。
 *  --output 前缀与 --ext-diff 对一切子命令是落盘/外部执行面，恒逐出 */
function gitReadonly(argv: readonly string[]): boolean {
  if (argv.some((word) => word.startsWith("--output") || word === "--ext-diff")) return false;
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  if (sub === undefined) return true;
  if (!GIT_READONLY_SUBS.has(sub)) return false;
  const rest = argv.slice(argv.indexOf(sub) + 1);
  if (sub === "branch") return gitListOnlyForm(rest, GIT_BRANCH_MUTATION);
  if (sub === "tag") return gitListOnlyForm(rest, GIT_TAG_MUTATION);
  if (sub === "remote") return rest.every((word) => word.startsWith("-") && word !== "-"); // 裸列表/纯旗标（-v）
  if (sub === "reflog") {
    const first = rest.find((word) => !word.startsWith("-"));
    return first === undefined || first === "show"; // delete/expire 是变更面
  }
  return true;
}

/** sort 写/执行形态例外：-o 输出落文件（短旗簇内嵌 o——值旗 k/t/T/S/o 后不再有独立旗）、
 *  --output 及无歧义缩写（getopt_long）、--compress-program 外部程序钩子 */
const SORT_VALUE_FLAGS: ReadonlySet<string> = new Set(["k", "t", "T", "S", "o"]);

function sortReadonly(argv: readonly string[]): boolean {
  return !argv.slice(1).some((word) => {
    if (word.startsWith("--compress-program")) return true;
    if (word.startsWith("--o")) return true;
    if (word.startsWith("-") && !word.startsWith("--")) return clusterHasFlag(word, "o", SORT_VALUE_FLAGS);
    return false;
  });
}

/** uniq 写形态例外：INPUT OUTPUT 双操作数把 OUTPUT 当文件写。getopt 语义步进——
 *  `-f/-s/-w` 分离值不计操作数；首个操作数后全是操作数（`uniq in -x` 的 -x 是
 *  dash 名 OUTPUT 文件）；`--` 后全是操作数 */
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
      if (word === "-f" || word === "-s" || word === "-w") i += 1; // 分离值随旗跳过
      continue;
    }
    flagsDone = true;
    operands += 1;
  }
  return operands <= 1;
}

/** tree 写形态例外：-o/--output* 落文件（簇内 o 同算——值旗 L/I/H/P/o 后不再有独立旗） */
const TREE_VALUE_FLAGS: ReadonlySet<string> = new Set(["L", "I", "H", "P", "o"]);

function treeReadonly(argv: readonly string[]): boolean {
  return !argv.slice(1).some((word) => {
    if (word.startsWith("--o")) return true;
    if (word.startsWith("-") && !word.startsWith("--")) return clusterHasFlag(word, "o", TREE_VALUE_FLAGS);
    return false;
  });
}

/** date 例外：仅裸 `date` 与 +FORMAT 显示形只读——`-s`/GNU `-d` 之外，POSIX 操作数形
 *  （`date 01010101`）与 BSD `-d`（设 DST）都是系统状态变更，一律逐出 */
function dateReadonly(argv: readonly string[]): boolean {
  return argv.slice(1).every((word) => word.startsWith("+"));
}

/** hostname 例外：仅裸显示形只读——带操作数即改主机名（系统状态变更） */
function hostnameReadonly(argv: readonly string[]): boolean {
  return argv.length === 1;
}

const READONLY_EXCEPT: ReadonlyMap<string, (argv: readonly string[]) => boolean> = new Map([
  ["git", gitReadonly],
  ["find", findReadonly],
  ["sort", sortReadonly],
  ["uniq", uniqReadonly],
  ["tree", treeReadonly],
  ["date", dateReadonly],
  ["hostname", hostnameReadonly],
]);

/** 单命令只读判定（argv 干净词面——wrappers 已剥）。非白名单成员一律 false（M5：例外
 *  条件不得绕过成员资格） */
export function commandReadonly(argv: readonly string[]): boolean {
  if (argv.length === 0) return true; // 纯重定向宿主的只读性由重定向面单独裁决
  const base = basenameOfWord(argv[0] ?? "");
  if (!READONLY_VERBS.has(base)) return false;
  const except = READONLY_EXCEPT.get(base);
  return except === undefined ? true : except(argv);
}
