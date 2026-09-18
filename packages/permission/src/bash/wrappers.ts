// bash 裁决的 argv 政策层（docs/EXEC-ENV.md §14.2 边界 3/4/8）：包装器剥离表（exact/bounded——
// 未知 flag fail-closed → ask）、不透明代码面（opaque——可被 allow 规则以用户信任越过）、解释器
// 家族（-c 字面量再解析/文件操作数/stdin/赋值前缀 → opaque；再解析 unparseable → 外层 ask 传染）、
// payload 提取（xargs/find -exec/parallel——空载荷或含解释器 → 注入，payload 词自成命令入裁决）、
// 字符串实参代码执行形（awk 族位置实参 / -e/-c 旗后实参 / git -c）。结构失败类（ask）与不透明
// 信任类（opaque）分离：前者静态裁决失格不可越 allow，后者是用户可委托的信任决策。

import type { BashParse, ParsedCommand } from "./ast.ts";
import { INTERPRETER_FAMILY } from "./injection.ts";

export { isInterpreterName } from "./injection.ts";

export type Reparse = (src: string) => BashParse;

export function basenameOf(word: string): string {
  if (!word.includes("/")) return word;
  return word.split("/").filter(Boolean).pop() ?? word;
}

/** 不透明代码面：载荷/文件即代码或系统观测器——恒 ask（allow 可越） */
const OPAQUE_ARGV0: ReadonlySet<string> = new Set([
  "source", ".", "ssh", "docker", "podman", "kubectl", "osascript", "script", "coproc",
  "strace", "ltrace", "valgrind",
]);

/** 解释器家族（词汇在 injection.ts——ast 管道判定共用） */
const INTERPRETERS: ReadonlySet<string> = INTERPRETER_FAMILY;
const BASH_FAMILY: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** 剥后结构残渣集（time { sudo id; } 实测解析成 argv=[time,{,sudo,id]——剥离后暴露残渣即 ask） */
const JUNK: ReadonlySet<string> = new Set(["{", "}", "then", "fi", "do", "done", "else", "elif", "esac", "in", "!"]);

/** 字符串实参代码执行形：awk 族首个非旗实参即程序文本（无需 -e） */
const AWK_FAMILY: ReadonlySet<string> = new Set(["awk", "gawk", "mawk"]);

const DYNAMIC_TEXT = /[$`*?[]/; // 载荷文本含展开/通配字符——静态不可再解析

export function applyCommandPolicy(commands: readonly ParsedCommand[], reparse: Reparse): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  const queue = [...commands];
  while (queue.length > 0) {
    const cmd = queue.shift();
    if (cmd !== undefined) out.push(policyOf(cmd, reparse, queue));
  }
  return out;
}

function policyOf(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  if (cmd.argv.length === 0) return cmd; // 纯重定向宿主/赋值合成单元——无 argv0 可剥
  const base = basenameOf(cmd.argv[0] ?? "");
  const strip = stripWrapper(cmd.argv, base);
  if (strip.kind === "stripped") {
    const argv = strip.argv;
    if (argv.length === 0 || JUNK.has(argv[0] ?? "")) return { ...cmd, argv, ask: `wrapper:${base}` };
    const envPrefix = strip.envPrefix === true || cmd.assignmentPrefix === true; // env VAR=x 介导的赋值前缀
    return policyOf({ ...cmd, argv, ...(envPrefix ? { assignmentPrefix: true } : {}) }, reparse, queue); // 剥后重跑——嵌套包装器（xargs timeout sudo）
  }
  if (strip.kind === "fail") return { ...cmd, ask: `wrapper:${base}` }; // 未知 flag——fail-closed
  if (strip.kind === "opaque") return { ...cmd, opaque: strip.reason };
  return specialPolicy(cmd, base, { reparse, queue });
}

/** 包装器之外的特殊 argv0 政策（解释器/载荷载体/不透明面） */
function specialPolicy(cmd: ParsedCommand, base: string, ctx: PolicyCtx): ParsedCommand {
  if (isInterpreter(base)) return interpreterPolicy({ cmd, base, ...ctx });
  if (base === "eval") return evalPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "trap") return trapPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "git" && cmd.argv[1] === "-c") return { ...cmd, opaque: "opaque-code:git-c" }; // 内联配置/别名执行面
  if (AWK_FAMILY.has(base) && cmd.argv.length > 1) return { ...cmd, opaque: "opaque-code:awk" };
  if (base === "xargs" || base === "parallel") return payloadPolicy(cmd, base, ctx.queue);
  if (base === "find") return findExecPolicy(cmd, ctx.queue);
  if (OPAQUE_ARGV0.has(base)) return { ...cmd, opaque: `opaque-code:${base}` };
  return cmd;
}

function isInterpreter(base: string): boolean {
  return INTERPRETERS.has(base) || /^python\d/.test(base);
}

type StripOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "stripped"; readonly argv: readonly string[]; readonly envPrefix?: boolean }
  | { readonly kind: "fail" }
  | { readonly kind: "opaque"; readonly reason: string };

const STRIP_NONE: StripOutcome = { kind: "none" };

function stripWrapper(argv: readonly string[], base: string): StripOutcome {
  switch (base) {
    case "nohup":
    case "setsid":
    case "exec":
      return { kind: "stripped", argv: argv.slice(1) };
    case "command":
    case "builtin": {
      const rest = argv.slice(1);
      return { kind: "stripped", argv: rest[0] === "-p" ? rest.slice(1) : rest };
    }
    case "time": {
      const rest = argv.slice(1);
      return { kind: "stripped", argv: rest[0] === "-p" ? rest.slice(1) : rest };
    }
    case "env":
      return stripEnv(argv);
    case "timeout":
      return stripTimeout(argv);
    case "nice":
      return stripNice(argv);
    case "stdbuf":
      return stripStdbuf(argv);
    case "watch":
      return stripWatch(argv);
    default:
      return STRIP_NONE;
  }
}

/** env [-i] [-u X] [--] [VAR=x…] cmd——-S/--split-string 载荷即命令行 → opaque；未知旗 → fail；
 *  丢弃的 VAR=x 记 envPrefix（载荷为解释器时按环境注入链处理——env BASH_ENV=x bash） */
function stripEnv(argv: readonly string[]): StripOutcome {
  let at = 1;
  let envPrefix = false;
  for (;;) {
    const word = argv[at];
    if (word === undefined || word === "--") {
      at += word !== undefined ? 1 : 0;
      break;
    }
    if (word === "-i") {
      at += 1;
      continue;
    }
    if (word === "-u") {
      at += 2;
      continue;
    }
    if (word === "-S" || word === "--split-string") return { kind: "opaque", reason: "opaque-code:env" };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1;
      envPrefix = true;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  return envPrefix ? { kind: "stripped", argv: argv.slice(at), envPrefix } : { kind: "stripped", argv: argv.slice(at) };
}

/** timeout [旗] <时长> cmd——时长形状不符即 fail（误吞命令词会把载荷藏进"时长"位） */
function stripTimeout(argv: readonly string[]): StripOutcome {
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    if (word === "--foreground" || word === "--preserve-status" || word === "--verbose" || word === "-h" || word === "-V") {
      at += 1;
      continue;
    }
    if (word === "-k" || word === "-s") {
      at += 2;
      continue;
    }
    if (word.startsWith("--kill-after=") || word.startsWith("--signal=")) {
      at += 1;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  const duration = argv[at];
  if (duration === undefined || !/^\d+(\.\d+)?[smhd]?$/.test(duration)) return { kind: "fail" };
  return { kind: "stripped", argv: argv.slice(at + 1) };
}

/** nice [-n N | -N | --adjustment=N] cmd */
function stripNice(argv: readonly string[]): StripOutcome {
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    if (word === "-n") {
      at += 2;
      continue;
    }
    if (/^-\d+$/.test(word) || word.startsWith("--adjustment=") || word === "--") {
      at += 1;
      if (word === "--") break;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  return { kind: "stripped", argv: argv.slice(at) };
}

/** stdbuf [-o L | -e L | -i L | --output=L …] cmd——附着形 -oL 一词 */
function stripStdbuf(argv: readonly string[]): StripOutcome {
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    const attached = /^-([oei])(.+)$/.exec(word);
    if (word === "-o" || word === "-e" || word === "-i") {
      at += 2;
      continue;
    }
    if (attached !== null) {
      at += 1;
      continue;
    }
    if (word.startsWith("--output=") || word.startsWith("--error=") || word.startsWith("--input=") || word === "--") {
      at += 1;
      if (word === "--") break;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  return { kind: "stripped", argv: argv.slice(at) };
}

/** watch [-n N] [旗] cmd——含 n 的短簇旗形（-dn）不可静态拆 → fail */
function stripWatch(argv: readonly string[]): StripOutcome {
  const watchLongs: ReadonlySet<string> = new Set(["--no-title", "--differences", "--chgexit", "--precise", "--color", "--exec"]);
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    if (word === "-n") {
      at += 2;
      continue;
    }
    if (watchLongs.has(word)) {
      at += 1;
      continue;
    }
    if (/^-[a-z]+$/.test(word)) {
      if (word.includes("n")) return { kind: "fail" }; // -n 变体簇——间隔语义不可静态拆
      at += 1;
      continue;
    }
    if (word.startsWith("-")) return { kind: "fail" };
    break;
  }
  return { kind: "stripped", argv: argv.slice(at) };
}

interface FlagScan {
  /** 代码旗（-c/-e/-lc 等）后的载荷词面 */
  readonly codePayload?: string;
  readonly stdinFlag?: boolean;
  readonly operand?: string;
  readonly unknownFlag?: boolean;
}

const SCAN_EMPTY: FlagScan = {};

/** 解释器旗面扫描：-- 长旗跳过；短簇含 c/e（家族语义）→ 载荷=次词；bash 族含 s → stdin；
 *  非旗词即文件操作数。 */
function scanInterpreterFlags(argv: readonly string[], bashFamily: boolean): FlagScan {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    if (word === undefined) continue;
    if (word === "--") {
      const next = argv[i + 1];
      return next === undefined ? SCAN_EMPTY : { operand: next };
    }
    if (word.startsWith("--")) continue; // 长选项（--norc 等）——bash -e 是 errexit 非代码旗，长旗无载荷形
    if (/^-[a-zA-Z]+$/.test(word)) {
      const codeFlag = bashFamily ? word.includes("c") : word.includes("c") || word.includes("e");
      if (codeFlag) {
        const payload = argv[i + 1];
        return payload === undefined ? { unknownFlag: true } : { codePayload: payload };
      }
      if (word.includes("s")) return { stdinFlag: true };
      continue;
    }
    return { operand: word };
  }
  return SCAN_EMPTY;
}

interface InterpreterCtx {
  readonly cmd: ParsedCommand;
  readonly base: string;
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

interface PolicyCtx {
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

/** 解释器家族四规则（§14.2 边界 4）：赋值前缀/stdin 喂入/文件操作数/未知旗 → opaque；
 *  -c 字面量再解析（bash 族），载荷动态 → opaque，再解析失败 → 外层 ask 传染。 */
function interpreterPolicy(ctx: InterpreterCtx): ParsedCommand {
  const { cmd, base, reparse, queue } = ctx;
  const opaque = `opaque-code:${base}`;
  if (cmd.assignmentPrefix === true) return { ...cmd, opaque }; // BASH_ENV 类环境注入链
  if (cmd.redirects.some((r) => r.face === "input")) return { ...cmd, opaque }; // bash < x / sh <<EOF——stdin 喂入
  const scan = scanInterpreterFlags(cmd.argv, BASH_FAMILY.has(base));
  if (scan.codePayload !== undefined) {
    if (!BASH_FAMILY.has(base)) return { ...cmd, opaque }; // 非 bash 族代码（python -c / node -e）——不可再解析
    if (DYNAMIC_TEXT.test(scan.codePayload)) {
      return { ...cmd, ask: opaque }; // 载荷动态——静态失格：ask（full 档不得因 dynamic 早退放行）
    }
    const reparsed = reparse(scan.codePayload);
    if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
    queue.push(...reparsed.commands);
    return cmd;
  }
  if (scan.stdinFlag === true || scan.operand !== undefined || scan.unknownFlag === true) return { ...cmd, opaque };
  if (cmd.stdinFed === true) return { ...cmd, opaque }; // 裸解释器 + 管道/payload 喂入（xargs sh / | timeout 5 sh）——stdin 即代码
  return cmd; // 裸解释器（无操作数无 -c、stdin 未喂）——REPL 读空 stdin 即退，同现行
}

function evalPolicy(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  const payload = cmd.argv[1];
  if (payload === undefined) return cmd; // 裸 eval 空转
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, injection: cmd.injection ?? "eval" }; // 动态载荷兜底
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
  queue.push(...reparsed.commands);
  return cmd;
}

/** trap 'code' EVENT——载荷延迟执行：字面量再解析并入；动态载荷与 eval 同类（延迟代码不可见，
 *  不可被 allow 越） */
function trapPolicy(cmd: ParsedCommand, reparse: Reparse, queue: ParsedCommand[]): ParsedCommand {
  const payload = cmd.argv[1] === "--" ? cmd.argv[2] : cmd.argv[1];
  if (payload === undefined) return cmd;
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, injection: "eval" };
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" };
  queue.push(...reparsed.commands);
  return cmd;
}

interface PayloadScan {
  readonly rest: readonly string[] | undefined; // undefined = 未知旗 fail-closed
}

/** xargs/parallel 自身旗面：-I/-d/-n/-P/-E/-s/-a（可带实参/附着形）、-j/--jobs（parallel）；
 *  首个非旗词 = payload 命令起点。 */
/** xargs/parallel 自身旗面：无实参短旗（-0/-r/-t/-x——xargs）与带实参短旗（-I/-d/-n/-P/-E/-s/-a/
 *  -L/-l；-j/-J 为 parallel）分开；长旗无实参集与 = 附着形；首个非旗词 = payload 起点。 */
function scanCarrierFlags(argv: readonly string[], base: string): PayloadScan {
  const noArgShorts: ReadonlySet<string> = base === "xargs" ? new Set(["0", "r", "t", "x"]) : new Set<string>();
  const argShorts: ReadonlySet<string> = base === "xargs" ? new Set(["I", "d", "n", "P", "E", "s", "a", "L", "l"]) : new Set(["j", "J"]);
  const longs: ReadonlySet<string> =
    base === "xargs"
      ? new Set(["--no-run-if-empty", "--verbose", "--exit", "--null", "--replace", "--max-args", "--max-procs", "--arg-file", "--delimiter"])
      : new Set(["--jobs", "--keep-order", "--line-buffer", "--dry-run", "--tag", "--ungroup", "--halt"]);
  let at = 1;
  for (;;) {
    const word = argv[at];
    if (word === undefined) break;
    if (word === "--") {
      at += 1;
      break;
    }
    if (longs.has(word)) {
      at += 1;
      continue;
    }
    if (/^--[a-z-]+=/.test(word)) {
      at += 1;
      continue;
    }
    const short = /^-([a-zA-Z])(.*)$/.exec(word);
    if (short !== null) {
      const step = shortFlagStep(short, noArgShorts, argShorts);
      if (step === undefined) return { rest: undefined };
      at += step;
      continue;
    }
    if (word.startsWith("-")) return { rest: undefined };
    break;
  }
  return { rest: argv.slice(at) };
}

/** 短旗步进：无实参旗 +1（附着形不支持——保守）；带实参旗附着 +1 / 分离 +2；未知旗 undefined */
function shortFlagStep(match: RegExpExecArray, noArgShorts: ReadonlySet<string>, argShorts: ReadonlySet<string>): number | undefined {
  const flag = match[1];
  const attached = match[2] ?? "";
  if (flag === undefined) return undefined;
  if (noArgShorts.has(flag)) return attached === "" ? 1 : undefined;
  if (!argShorts.has(flag)) return undefined;
  return attached === "" ? 2 : 1;
}

/** xargs/parallel：payload 词自成命令入裁决（嵌套包装器/解释器由队列再过政策；stdinFed 标记
 *  让裸解释器载荷吃到 ask——`ls | xargs sh`）；空载荷（stdin 运行时填充）→ 注入恒 ask。 */
function payloadPolicy(cmd: ParsedCommand, base: string, queue: ParsedCommand[]): ParsedCommand {
  const scan = scanCarrierFlags(cmd.argv, base);
  if (scan.rest === undefined) return { ...cmd, ask: `wrapper:${base}` };
  if (scan.rest.length === 0) return { ...cmd, injection: cmd.injection ?? "xargs-shell" };
  queue.push({
    argv: scan.rest,
    dynamic: scan.rest.some((word) => DYNAMIC_TEXT.test(word)),
    redirects: [],
    raw: scan.rest.join(" "),
    stdinFed: true,
  });
  return cmd;
}

/** find -exec/-execdir/-ok/-okdir payload 提取：终止符 ; / + 在词面（\; 重构为 ;）；
 *  无终止符取余词（保守过判方向）；空 payload → 注入 find-exec。 */
function findExecPolicy(cmd: ParsedCommand, queue: ParsedCommand[]): ParsedCommand {
  let injection: ParsedCommand["injection"];
  for (let i = 1; i < cmd.argv.length; i++) {
    const word = cmd.argv[i];
    if (word !== "-exec" && word !== "-execdir" && word !== "-ok" && word !== "-okdir") continue;
    const payload: string[] = [];
    let at = i + 1;
    while (at < cmd.argv.length) {
      const w = cmd.argv[at];
      if (w === ";" || w === "+") break;
      if (w !== undefined) payload.push(w);
      at += 1;
    }
    i = at;
    if (payload.length === 0) {
      injection = "find-exec";
      continue;
    }
    queue.push({ argv: payload, dynamic: payload.some((w) => DYNAMIC_TEXT.test(w)), redirects: [], raw: payload.join(" "), stdinFed: true });
  }
  return injection === undefined ? cmd : { ...cmd, injection };
}
