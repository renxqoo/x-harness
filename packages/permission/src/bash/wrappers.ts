// bash 裁决的 argv 政策层（docs/EXEC-ENV.md §14.2/§14.12 裁决⑥）：包装器剥离只剩平凡三件
// （env 旗面+赋值、nohup、time 容 -p）——其余已知运行器不解析旗面，统一「载荷词含提权词 →
// 结构失败类 ask（full 档亦 deny）；干净 → opaque（allow 可委托）」。不透明面原则化：
// EXECUTORS 词表 × 一条规则（任何实参/输入面重定向/stdin 喂入/赋值前缀 → opaque；bash 族 -c
// 字面量再解析与 bun 子命令例外）。payload 提取（xargs/find -exec/parallel）与 eval/trap 载荷
// 再解析保留。结构失败类（ask）与不透明信任类（opaque）分离：前者不可越 allow，后者可委托。

import type { BashParse, ParsedCommand } from "./ast.ts";
import { INTERPRETER_FAMILY } from "./injection.ts";
import { SUDO_LIKE } from "./hard-deny.ts";

export { isInterpreterName } from "./injection.ts";

export type Reparse = (src: string) => BashParse;

export function basenameOf(word: string): string {
  if (!word.includes("/")) return word;
  return word.split("/").filter(Boolean).pop() ?? word;
}

/** 已知运行器（§14.12 裁决⑥）：不再解析旗面——提权词命中 → 硬 ask；干净 → opaque */
const RUNNERS: ReadonlySet<string> = new Set([
  "setsid", "exec", "command", "builtin", "timeout", "nice", "stdbuf", "watch",
  "coproc", "script", "strace", "ltrace", "valgrind",
]);

/** 内容执行器词表（原则规则的对象面，§14.12）：解释器族（isInterpreterName 含 python3.11）之外 */
const EXECUTOR_WORDS: ReadonlySet<string> = new Set([
  "source", ".", "awk", "gawk", "mawk", "ssh", "docker", "podman", "kubectl", "osascript",
]);

const BASH_FAMILY: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** bun 子命令（身兼包管理器）：不作内容执行——落档口径与 make/npm run/yarn 对齐（§14.11） */
const BUN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run", "test", "install", "add", "remove", "update", "upgrade", "link", "unlink", "publish",
  "audit", "outdated", "pm", "init", "create", "build", "deploy", "patch",
]);

/** 剥后结构残渣集（time { sudo id; } 实测解析成 argv=[time,{,sudo,id]——剥离后暴露残渣即 ask） */
const JUNK: ReadonlySet<string> = new Set(["{", "}", "then", "fi", "do", "done", "else", "elif", "esac", "in", "!"]);

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
    return policyOf({ ...cmd, argv, ...(envPrefix ? { assignmentPrefix: true } : {}) }, reparse, queue); // 剥后重跑——嵌套包装器（xargs env git）
  }
  if (strip.kind === "fail") return { ...cmd, ask: `wrapper:${base}` }; // 未知旗——fail-closed
  if (strip.kind === "opaque") return { ...cmd, opaque: strip.reason };
  return specialPolicy(cmd, base, { reparse, queue });
}

interface PolicyCtx {
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

/** 剥离之外的特殊 argv0 政策（运行器/执行器/载荷载体） */
function specialPolicy(cmd: ParsedCommand, base: string, ctx: PolicyCtx): ParsedCommand {
  if (RUNNERS.has(base)) return runnerPolicy(cmd, base);
  if (isExecutorName(base)) return executorPolicy({ cmd, base, reparse: ctx.reparse, queue: ctx.queue });
  if (base === "eval") return evalPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "trap") return trapPolicy(cmd, ctx.reparse, ctx.queue);
  if (base === "git" && cmd.argv[1] === "-c") return { ...cmd, opaque: "opaque-code:git-c" }; // 内联配置/别名执行面（实证 B-P0-5）
  if (base === "xargs" || base === "parallel") return payloadPolicy(cmd, base, ctx.queue);
  if (base === "find") return findExecPolicy(cmd, ctx.queue);
  return cmd;
}

function isExecutorName(base: string): boolean {
  return INTERPRETER_FAMILY.has(base) || /^python\d/.test(base) || EXECUTOR_WORDS.has(base);
}

/** 运行器统一政策：载荷词含提权词（sudo/doas/su，basename 归一）→ 硬 ask（full 档经
 *  fullDecision 兑现为 deny——裁决⑤提权面不破）；干净 → opaque（allow 可委托）。 */
function runnerPolicy(cmd: ParsedCommand, base: string): ParsedCommand {
  const elevates = cmd.argv.slice(1).some((word) => SUDO_LIKE.has(basenameOf(word)));
  if (elevates) return { ...cmd, ask: "hard-deny:sudo" };
  return { ...cmd, opaque: `opaque-code:${base}` };
}

interface InterpreterCtx {
  readonly cmd: ParsedCommand;
  readonly base: string;
  readonly reparse: Reparse;
  readonly queue: ParsedCommand[];
}

/** 内容执行器原则规则（§14.12）：任何实参/输入面重定向/stdin 喂入/赋值前缀 → opaque；
 *  裸执行器放行；bash 族 -c/-lc 字面量载荷再解析（内容可见即非不透明）；bun 子命令例外。 */
function executorPolicy(ctx: InterpreterCtx): ParsedCommand {
  const { cmd, base, reparse, queue } = ctx;
  const opaque = `opaque-code:${base}`;
  if (cmd.assignmentPrefix === true) return { ...cmd, opaque }; // BASH_ENV 类环境注入链
  if (cmd.stdinFed === true || cmd.redirects.some((r) => r.face === "input")) return { ...cmd, opaque }; // 管道/heredoc/herestring/< <(…) 喂入
  if (cmd.argv.length === 1) return cmd; // 裸执行器——REPL 读空 stdin 即退，同现行
  if (base === "bun" && BUN_SUBCOMMANDS.has(cmd.argv[1] ?? "")) return cmd; // §14.11 子命令形非内容执行
  const payload = BASH_FAMILY.has(base) ? cPayloadOf(cmd.argv) : null; // -c 再解析仅 bash 族——其余代码非 bash 语法
  if (payload === null) return { ...cmd, opaque }; // 无 -c 载荷——任何实参（文件操作数/程序文本/远端命令）内容不可见
  if (payload === "") return { ...cmd, ask: opaque }; // -c 后无载荷（stdin 运行时填充）——静态失格
  if (DYNAMIC_TEXT.test(payload)) return { ...cmd, ask: opaque }; // 载荷动态——静态失格：恒 ask
  const reparsed = reparse(payload);
  if (!reparsed.ok) return { ...cmd, ask: reparsed.kind === "parser-unavailable" ? "parser-unavailable" : "unparseable command" }; // 传染
  queue.push(...reparsed.commands);
  return cmd;
}

/** bash 族 -c/-lc 短簇后的载荷词面；无代码旗 → null（交给原则规则 opaque）。仅 bash 族调用。 */
function cPayloadOf(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i];
    if (word === undefined || word === "--" || !/^-[a-zA-Z]+$/.test(word)) break; // 首个非旗词是操作数
    if (!word.includes("c")) continue;
    const payload = argv[i + 1];
    return payload === undefined ? "" : payload;
  }
  return null;
}

type StripOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "stripped"; readonly argv: readonly string[]; readonly envPrefix?: boolean }
  | { readonly kind: "fail" }
  | { readonly kind: "opaque"; readonly reason: string };

const STRIP_NONE: StripOutcome = { kind: "none" };

/** 平凡剥离族（§14.12 裁决⑥）：env（旗面+赋值）、nohup、time（容 -p）；其余 → none（运行器政策承接） */
function stripWrapper(argv: readonly string[], base: string): StripOutcome {
  if (base === "env") return stripEnv(argv);
  if (base === "nohup") return { kind: "stripped", argv: argv.slice(1) };
  if (base === "time") {
    const rest = argv.slice(1);
    return { kind: "stripped", argv: rest[0] === "-p" ? rest.slice(1) : rest };
  }
  return STRIP_NONE;
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
