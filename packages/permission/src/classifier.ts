// 安全分类器（docs/PERMISSION-V2-DESIGN.md §4.4——P1 显式交付物）：裁决梯末段对
// 静态命令的三分类。fail-closed 铁律：未知动词不得入只读类（对抗用例钉死——
// find -delete/dd/tar -x 类破坏形态必须在未分类桶落 ask/contained）。
// 只读动词白名单与其逐动词例外条件的单一真相在 readonly-verbs.ts（独立审计面）。

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "./bash/ast.ts";
import { basenameOfWord, commandReadonly, findCarrierSafe } from "./readonly-verbs.ts";

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
  const base = basenameOfWord(argv[0] ?? "");
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

/** 载体段跳过判定（前提=载荷已提取为独立段）：opaque 段（watch 等 RUNNERS）载荷未提取
 *  不得跳；find 段仅在 -exec 族载荷已提取且留段无写形态时豁免——-delete/-fprint* 留段
 *  副作用不得随载体直通（findCarrierSafe） */
function carrierSkipOf(cmd: ParsedCommand, base: string, multiSegment: boolean): boolean {
  if (!multiSegment || !CARRIER_SKIP.has(base) || cmd.opaque !== undefined) return false;
  return base !== "find" || findCarrierSafe(cmd.argv);
}

/** 裸载体（无操作数，stdin 即闭）——只读径 */
function bareCarrier(base: string, argv: readonly string[]): boolean {
  return argv.length === 1 && (CARRIER_SKIP.has(base) || TRANSPORT_STRIP.has(base));
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
    if (carrierSkipOf(cmd, base, multiSegment)) continue;
    if (bareCarrier(base, cmd.argv)) continue;
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
