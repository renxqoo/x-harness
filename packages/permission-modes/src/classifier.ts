// 安全分类器（docs/PERMISSION-V2-DESIGN.md §4.4——P1 显式交付物）：裁决梯末段对
// 静态命令的三分类。fail-closed 铁律：未知动词不得入只读类（对抗用例钉死——
// find -delete/dd/tar -x 类破坏形态必须在未分类桶落 ask/contained）。
// 只读动词白名单与其逐动词例外条件的单一真相在 readonly-verbs.ts（独立审计面）。

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ParsedCommand } from "@x-harness/permission";
import { basenameOfWord, commandReadonly, findCarrierSafe } from "./readonly-verbs.ts";

/** 界内合成写安全动词（basename 或 家族×子命令）：直通档下界内写自动（U5 姿势——
 *  破坏性动词 rm/mkfs/dd/chmod 永不入选，落未分类 ask） */
const WRITE_SAFE_VERBS: ReadonlySet<string> = new Set(["mkdir", "touch", "cp", "mv", "ln", "tee", "install"]);
const WRITE_SAFE_FAMILY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["add", "commit", "checkout", "switch", "restore", "stash", "pull", "fetch", "merge", "rebase", "clone", "init", "cherry-pick", "reset", "clean", "mv", "rm"])],
  ["npm", new Set(["install", "add", "ci", "uninstall", "run", "test", "build", "dev"])],
  ["pnpm", new Set(["install", "add", "ci", "remove", "run", "test", "build", "dev"])],
  ["yarn", new Set(["install", "add", "remove", "run", "test", "build", "dev"])],
  ["bun", new Set(["install", "add", "remove", "run", "test", "build", "dev"])],
  ["cargo", new Set(["build", "test", "check", "run", "fmt", "clippy", "add"])],
  ["go", new Set(["build", "test", "vet", "run", "mod", "fmt"])],
  ["docker", new Set(["build", "pull", "logs", "ps"])],
  ["uv", new Set(["run", "test"])],
]);
// P1-5（2026-09-28）逐出记录：npm/pnpm/bun 的 exec/x（拉起任意包/命令）、docker compose
//（down -v 销毁卷）、make *（任意 target=任意命令）、pip/uv pip/sync/add（全局环境写）——
// 无路径操作数的环境面目标原「界内写」豁免不再成立，一律落未分类 ask。
// 全局安装旗（-g/--global）同逐出：安装族的 site-packages/全局前缀写不可界内化。

/** 安装族全局旗（-g/--global）：全局前缀写不可界内化——有此旗即逐出写安全类 */
const GLOBAL_INSTALL = new Set(["npm", "pnpm", "yarn", "bun", "cargo"]);

/** 单命令写安全判定 */
function commandWriteSafe(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const base = basenameOfWord(argv[0] ?? "");
  if (GLOBAL_INSTALL.has(base) && argv.some((word) => word === "-g" || word === "--global")) return false;
  if (WRITE_SAFE_VERBS.has(base)) return true;
  const family = WRITE_SAFE_FAMILY.get(base);
  if (family === undefined) return false;
  const sub = argv.find((word, index) => index > 0 && !word.startsWith("-"));
  return sub !== undefined && family.has(sub);
}

/** 传输动词（wrappers 层载荷提取的载体——bash -c/env/timeout/xargs/eval 等）：
 *  载荷已作为独立命令段在列表内，外层载体不参与分类（跳过）；裸载体无操作数
 *  （stdin 即闭）计只读。解释器文件操作数（bash x.sh）不在此径——上游 opaque 恒 ask。 */
/** 多段管线中的载体段（载荷已提取为独立段）——整段跳过（内联 argv 不可分类）。
 *  xargs 已移 TRANSPORT_STRIP（P0-1：内联形 `xargs cat` 的载荷词必须参与分类——
 *  旧载体豁免让 `find … | xargs cat` 以只读直通读任意文件） */
const CARRIER_SKIP: ReadonlySet<string> = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "find", "parallel", "eval", "trap", "watch",
]);
/** 单段前缀剥离集：剥动词后跟的旗/时长/赋值词，余部即真命令（env VAR=1 ls / timeout 5 npm test / xargs cat） */
const TRANSPORT_STRIP: ReadonlySet<string> = new Set([
  "env", "nohup", "timeout", "nice", "stdbuf", "setsid", "command", "builtin", "xargs",
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
function carrierSkipOf(cmd: ParsedCommand, base: string, opts: { readonly multiSegment: boolean; readonly roots: readonly string[] }): boolean {
  if (!opts.multiSegment || !CARRIER_SKIP.has(base) || cmd.opaque !== undefined) return false;
  return base !== "find" || findCarrierSafe(cmd.argv, (word) => opts.roots.length === 0 || withinRoots(word, opts.roots));
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
    if (carrierSkipOf(cmd, base, { multiSegment, roots })) continue;
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

/** find 搜索根操作数界内判定（P0-1：`find ~ | xargs cat` 的无 -exec 形——词面只读但搜索
 *  范围越根，载荷 cat 的实参运行期才见。越根搜索根 → 逐出只读类） */
function findOperandsInRoot(argv: readonly string[], inRoot: (word: string) => boolean): boolean {
  return argv.slice(1).every((word) => {
    if (word.startsWith("-") || word.startsWith("!") || word === "(" || word === ")" || word === "{}") return true;
    const pathLike = word.includes("/") || word === "~" || word.startsWith("~/") || word === "." || word === "..";
    return !pathLike || inRoot(word);
  });
}

/** 单段三分类（roots 空=不做界内校验的纯词面形态） */
function segmentClass(argv: readonly string[], roots: readonly string[]): CommandClass {
  if (argv.length > 0 && basenameOfWord(argv[0] ?? "") === "find" && roots.length > 0 && !findOperandsInRoot(argv, (word) => withinRoots(word, roots))) return "unclassified";
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

/** 写安全动词的文件型操作数界内校验（对抗审查 #1：界外写零交互直通——越根操作数逐出
 *  写类）。B-bug-2 修正：① 裸 `..`/`.` 也是路径（resolve 后越根即逐出）；② 附着值旗
 *  （`--target-directory=/etc`、`-t../x`）按 `=` 后的值部判路径形——不再因 `-` 前缀整词跳过 */
function writeOperandsInRoot(argv: readonly string[], inRoot: (word: string) => boolean): boolean {
  const valueOf = (word: string): string | undefined => {
    if (!word.startsWith("-")) return word;
    const eq = word.indexOf("=");
    return eq === -1 ? undefined : word.slice(eq + 1);
  };
  return argv.slice(1).every((word) => {
    const value = valueOf(word);
    if (value === undefined) return true; // 纯旗词（无附着值）——非路径面
    if (value === "") return true; // `--target-directory=` 空值——运行时报错形态，非路径
    const pathLike = value.includes("/") || value === "~" || value.startsWith("~/") || value === ".." || value === ".";
    return !pathLike || inRoot(value);
  });
}
