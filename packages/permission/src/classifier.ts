// 安全分类器（docs/PERMISSION-V2-DESIGN.md §4.4——P1 显式交付物）：裁决梯末段对
// 静态命令的三分类。fail-closed 铁律：未知动词不得入只读类（对抗用例钉死——
// find -delete/dd/tar -x 类破坏形态必须在未分类桶落 ask/contained）。

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "./bash/ast.ts";

/** 纯只读动词白名单（basename）：无副作用观察类。保守维护——新增动词必须过
 *  对抗审查（写副作用动词混入 = 直通档无界破坏面） */
const READONLY_VERBS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "which", "file", "stat", "du", "df",
  "ps", "env", "printenv", "whoami", "uname", "date", "id", "hostname", "sort", "uniq",
  "cut", "tr", "diff", "cmp", "tree", "basename", "dirname", "realpath", "readlink",
  "jq", "true", "false", "test", "sleep", "grep", "rg", "find", "column",
  "md5sum", "sha1sum", "sha256sum", "git",
]);
// 注：awk/sed（程序体/w 命令=任意代码与任意路径写）、curl/wget（缺省落盘/上传实参）
// 不入只读表——网络与流编辑形态一律走未分类 ask（对抗审查 #2：写副作用动词禁入只读类）。

/** git 只读子命令（git 家族动词面大——push/push-like 一律不入选） */
const GIT_READONLY_SUBS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "branch", "tag", "remote", "describe", "rev-parse",
  "shortlog", "reflog", "ls-files", "ls-remote", "ls-tree", "cat-file", "blame", "var", "version",
]);

/** find 例外条件：无 -delete/-exec/-execdir/-ok/-fprintf*（纯检索） */
function findReadonly(argv: readonly string[]): boolean {
  return !argv.some((word) => word === "-delete" || word === "-exec" || word === "-execdir" || word === "-ok" || word.startsWith("-fprintf"));
}

/** git 家族判定：git <sub>（sub 只读）或 git 自身旗标形态（git --version） */
function gitReadonly(argv: readonly string[]): boolean {
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  if (sub === undefined) return true;
  return GIT_READONLY_SUBS.has(sub);
}

/** 单命令只读判定（argv 干净词面——wrappers 已剥） */
function commandReadonly(argv: readonly string[]): boolean {
  if (argv.length === 0) return true; // 纯重定向宿主的只读性由重定向面单独裁决
  const verb = argv[0] ?? "";
  const base = verb.includes("/") ? (verb.split("/").filter(Boolean).pop() ?? verb) : verb;
  if (base === "git") return gitReadonly(argv);
  if (base === "find") return findReadonly(argv);
  return READONLY_VERBS.has(base);
}

/** 界内合成写安全动词（basename 或 家族×子命令）：直通档下界内写自动（U5 姿势——
 *  破坏性动词 rm/mkfs/dd/chmod 永不入选，落未分类 ask） */
const WRITE_SAFE_VERBS: ReadonlySet<string> = new Set(["mkdir", "touch", "cp", "mv", "ln", "tee", "install"]);
const WRITE_SAFE_FAMILY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["add", "commit", "checkout", "switch", "restore", "stash", "pull", "fetch", "merge", "rebase", "clone", "init", "cherry-pick", "reset", "clean", "mv", "rm"])],
  ["npm", new Set(["install", "add", "ci", "uninstall", "run", "test", "build", "dev", "exec"])],
  ["pnpm", new Set(["install", "add", "ci", "remove", "run", "test", "build", "dev", "exec"])],
  ["yarn", new Set(["install", "add", "remove", "run", "test", "build", "dev"])],
  ["bun", new Set(["install", "add", "remove", "run", "test", "build", "dev", "x"])],
  ["cargo", new Set(["build", "test", "check", "run", "fmt", "clippy", "add"])],
  ["go", new Set(["build", "test", "vet", "run", "mod", "fmt"])],
  ["docker", new Set(["build", "compose", "pull", "logs", "ps"])],
  ["make", new Set(["*"])],
  ["uv", new Set(["run", "pip", "sync", "venv", "add"])],
  ["pip", new Set(["install"])],
]);

/** 单命令写安全判定 */
function commandWriteSafe(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const verb = argv[0] ?? "";
  const base = verb.includes("/") ? (verb.split("/").filter(Boolean).pop() ?? verb) : verb;
  if (WRITE_SAFE_VERBS.has(base)) return true;
  const family = WRITE_SAFE_FAMILY.get(base);
  if (family === undefined) return false;
  if (family.has("*")) return true;
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  return sub !== undefined && family.has(sub);
}

/** 传输动词（wrappers 层载荷提取的载体——bash -c/env/timeout/xargs/eval 等）：
 *  载荷已作为独立命令段在列表内，外层载体不参与分类（跳过）；裸载体无操作数
 *  （stdin 即闭）计只读。解释器文件操作数（bash x.sh）不在此径——上游 opaque 恒 ask。 */
/** 多段管线中的载体段（载荷已提取为独立段）——整段跳过（内联 argv 不可分类） */
const CARRIER_SKIP: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "xargs", "find", "parallel", "eval", "trap", "watch",
]);
/** 单段前缀剥离集：剥动词后跟的旗/时长/赋值词，余部即真命令（env VAR=1 ls / timeout 5 npm test） */
const TRANSPORT_STRIP: ReadonlySet<string> = new Set([
  "env", "nohup", "timeout", "nice", "stdbuf", "setsid", "command", "builtin",
]);

function basenameOfWord(word: string): string {
  return word.includes("/") ? (word.split("/").filter(Boolean).pop() ?? word) : word;
}

export type CommandClass = "readonly" | "write" | "unclassified";

/** 传输前缀剥离：`timeout 5 npm test` → [npm,test]（剥传输动词与旗/时长/赋值词）。
 *  剥空 = 纯载体（stdin 即闭）——readonly 径。 */
function stripTransport(argv: readonly string[]): readonly string[] {
  const out = [...argv];
  for (;;) {
    if (out.length === 0) return out;
    const base = basenameOfWord(out[0] ?? "");
    if (TRANSPORT_STRIP.has(base)) {
      out.shift();
      // 剥紧随的旗标/数字时长/赋值词（env VAR=1 / timeout 5）
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

/** 管线级分类（全段一致才入类——任一段未分类即管线未分类；只读段混写段=写）：
 *  调用前置条件=全段静态（dynamic/injection/ask 已在上游拦截）且重定向面已单独裁决。
 *  传输动词段的语义在其载荷（独立段或内联后缀）。 */
export function classifyPipeline(commands: readonly ParsedCommand[], hasOutputRedirect: boolean, roots: readonly string[] = []): CommandClass {
  let sawWrite = false;
  const multiSegment = commands.length > 1; // 载荷已提取为独立段——外层载体整段跳过
  for (const cmd of commands) {
    if (cmd.argv.length === 0) continue; // 重定向宿主由 hasOutputRedirect 汇总
    const base = basenameOfWord(cmd.argv[0] ?? "");
    if (multiSegment && CARRIER_SKIP.has(base)) continue;
    if (cmd.argv.length === 1 && (CARRIER_SKIP.has(base) || TRANSPORT_STRIP.has(base))) continue; // 裸载体（stdin 即闭）——只读径
    const effective = stripTransport(cmd.argv);
    if (effective.length === 0) continue; // 纯载体（无载荷/操作数）——只读径
    const cls = segmentClass(effective, roots);
    if (cls === "unclassified") return "unclassified";
    if (cls === "write") sawWrite = true;
  }
  if (sawWrite || hasOutputRedirect) return "write";
  return "readonly";
}

/** 单段三分类（roots 空=不做界内校验的纯词面形态） */
function segmentClass(argv: readonly string[], roots: readonly string[]): CommandClass {
  if (commandReadonly(argv)) return "readonly";
  if (!commandWriteSafe(argv)) return "unclassified";
  const inRoot = (word: string): boolean => roots.length === 0 || withinRoots(word, roots);
  return writeOperandsInRoot(argv, inRoot) ? "write" : "unclassified";
}

/** 词面路径界内判定（~ 展开家目录——家目录恒界外除非在 roots） */
function withinRoots(word: string, roots: readonly string[]): boolean {
  let target: string;
  if (word === "~") target = homedir();
  else if (word.startsWith("~/")) target = resolve(homedir(), word.slice(2));
  else target = resolve(roots[0] ?? process.cwd(), word);
  return roots.some((root) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/** 写安全动词的文件型操作数界内校验（对抗审查 #1：界外写零交互直通——越根操作数逐出写类） */
function writeOperandsInRoot(argv: readonly string[], inRoot: (word: string) => boolean): boolean {
  return argv.slice(1).every((word) => {
    if (word.startsWith("-")) return true;
    const pathLike = word.includes("/") || word === "~" || word.startsWith("~/");
    return !pathLike || inRoot(word);
  });
}
