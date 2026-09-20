// 命令行参数解析（docs/CLI.md §2.1）：表驱动纯函数，Result 形态（失败理由 = exit 2 文案）。
// 两段式：scan 收原始 token → finalize 校验成型。词表封闭：flag 集在 FLAG_SPECS、
// 枚举/互斥在 finalize 闭口；位置参数按 @ 前缀分流 file/messages。

import type { Result } from "@x-harness/core";
import { MODE_KNOBS } from "@x-harness/permission";
import type { ModeKnob } from "@x-harness/permission";
import { THINKING_LEVELS } from "./providers-file.ts";
import type { ThinkingLevelCli } from "./providers-file.ts";

export type OutputMode = "text" | "json";

export interface CliArgs {
  readonly print: boolean;
  readonly mode: OutputMode;
  readonly continueRecent: boolean;
  readonly resume: boolean;
  readonly session?: string;
  readonly noSession: boolean;
  readonly sessionDir?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevelCli;
  readonly permission?: ModeKnob;
  readonly apiKey?: string;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly noTools: boolean;
  readonly systemPrompt?: string;
  readonly appendSystemPrompts: readonly string[];
  readonly listModels: boolean;
  readonly listModelsSearch?: string;
  readonly version: boolean;
  readonly help: boolean;
  readonly messages: readonly string[];
  readonly fileArgs: readonly string[];
}

/** 值形态：single = 最后一次出现胜出；multi = 可重复累积 */
type FlagSpec = { readonly long: string; readonly short?: string; readonly arity: 0 | 1 | "optional"; readonly multi?: boolean };

const FLAG_SPECS: readonly FlagSpec[] = [
  { long: "--print", short: "-p", arity: 0 },
  { long: "--mode", arity: 1 },
  { long: "--continue", short: "-c", arity: 0 },
  { long: "--resume", short: "-r", arity: 0 },
  { long: "--session", arity: 1 },
  { long: "--no-session", arity: 0 },
  { long: "--session-dir", arity: 1 },
  { long: "--provider", arity: 1 },
  { long: "--model", arity: 1 },
  { long: "--thinking", arity: 1 },
  { long: "--permission", arity: 1 },
  { long: "--api-key", arity: 1 },
  { long: "--tools", short: "-t", arity: 1 },
  { long: "--exclude-tools", short: "-xt", arity: 1 },
  { long: "--no-tools", short: "-nt", arity: 0 },
  { long: "--system-prompt", arity: 1 },
  { long: "--append-system-prompt", arity: 1, multi: true },
  { long: "--list-models", arity: "optional" },
  { long: "--version", short: "-v", arity: 0 },
  { long: "--help", short: "-h", arity: 0 },
];

const SPEC_BY_LONG = new Map<string, FlagSpec>(FLAG_SPECS.map((spec) => [spec.long, spec]));
const LONG_BY_SHORT = new Map<string, string>(FLAG_SPECS.flatMap((spec) => (spec.short !== undefined ? [[spec.short, spec.long]] : [])));

/** scan 的中间形态：flag 原始值（boolean / 单值 / 多值累积）+ 位置参数 */
interface RawArgs {
  readonly flags: Map<string, boolean | string | string[]>;
  readonly messages: string[];
  readonly fileArgs: string[];
}

function storeFlag(raw: RawArgs, long: string, value: boolean | string): void {
  const spec = SPEC_BY_LONG.get(long);
  if (spec?.multi === true) {
    const prior = raw.flags.get(long);
    const list = Array.isArray(prior) ? prior : [];
    list.push(String(value));
    raw.flags.set(long, list);
  } else {
    raw.flags.set(long, value);
  }
}

function flagBool(raw: RawArgs, long: string): boolean {
  return raw.flags.get(long) === true;
}

function flagValue(raw: RawArgs, long: string): string | undefined {
  const value = raw.flags.get(long);
  return typeof value === "string" ? value : undefined;
}

/** 位置参数分流（docs/CLI.md §2.1）：@ 前缀进 fileArgs，其余进 messages */
function routePositional(token: string, raw: RawArgs): void {
  if (token.startsWith("@")) raw.fileArgs.push(token.slice(1));
  else raw.messages.push(token);
}

/** 归一 token → [long 名, 附带值]；支持 --flag=value 与短项映射 */
function normalize(token: string): Result<{ readonly long: string; readonly attached?: string }> {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq === -1) {
      if (!SPEC_BY_LONG.has(token)) return { ok: false, reason: `unknown option: ${token}` };
      return { ok: true, value: { long: token } };
    }
    const name = token.slice(0, eq);
    if (!SPEC_BY_LONG.has(name)) return { ok: false, reason: `unknown option: ${name}` };
    return { ok: true, value: { long: name, attached: token.slice(eq + 1) } };
  }
  const long = LONG_BY_SHORT.get(token);
  if (long === undefined) return { ok: false, reason: `unknown option: ${token}` };
  return { ok: true, value: { long } };
}

function isFlagLike(token: string | undefined): boolean {
  return token !== undefined && token.length > 1 && token.startsWith("-");
}

/** 消费一个 flag token（含取值），返回消费的 token 数 */
function consumeFlag(raw: RawArgs, argv: readonly string[], index: number): Result<number> {
  const token = argv[index];
  if (token === undefined) return { ok: false, reason: "unreachable token" };
  const norm = normalize(token);
  if (!norm.ok) return norm;
  const spec = SPEC_BY_LONG.get(norm.value.long);
  if (spec === undefined) return { ok: false, reason: `unknown option: ${token}` };
  if (spec.arity === 0) {
    storeFlag(raw, spec.long, true);
    return { ok: true, value: 1 };
  }
  if (norm.value.attached !== undefined) {
    storeFlag(raw, spec.long, norm.value.attached);
    return { ok: true, value: 1 };
  }
  const next = argv[index + 1];
  const value = spec.arity === 1 || !isFlagLike(next) ? next : undefined;
  if (value === undefined) {
    if (spec.arity === 1) return { ok: false, reason: `option ${spec.long} requires a value` };
    storeFlag(raw, spec.long, true); // 可选值 flag（--list-models）裸用
    return { ok: true, value: 1 };
  }
  storeFlag(raw, spec.long, value);
  return { ok: true, value: value === next ? 2 : 1 };
}

/** 主循环：flag 值消费（next token 非 `-` 开头才可作值）+ `--` 后全按位置参数 */
function scan(argv: readonly string[]): Result<RawArgs> {
  const raw: RawArgs = { flags: new Map(), messages: [], fileArgs: [] };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === "--") {
      for (const rest of argv.slice(index + 1)) routePositional(rest, raw);
      break;
    }
    if (isFlagLike(token)) {
      const step = consumeFlag(raw, argv, index);
      if (!step.ok) return step;
      index += step.value;
      continue;
    }
    routePositional(token, raw);
    index += 1;
  }
  return { ok: true, value: raw };
}

function splitList(value: string): readonly string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/** 二元互斥表（docs/CLI.md §2.1）；presence = 布尔真或值在场 */
const CONFLICTS: readonly { readonly a: string; readonly b: string; readonly message: string }[] = [
  { a: "--resume", b: "--print", message: "-r/--resume needs an interactive terminal; use --session or -c with -p" },
  { a: "--no-session", b: "--continue", message: "--no-session cannot be combined with -c/--continue" },
  { a: "--no-session", b: "--resume", message: "--no-session cannot be combined with -r/--resume" },
  { a: "--no-session", b: "--session", message: "--no-session cannot be combined with --session" },
  { a: "--session", b: "--continue", message: "--session cannot be combined with -c/--continue" },
  { a: "--session", b: "--resume", message: "--session cannot be combined with -r/--resume" },
  { a: "--no-tools", b: "--tools", message: "--no-tools cannot be combined with --tools" },
  { a: "--no-tools", b: "--exclude-tools", message: "--no-tools cannot be combined with --exclude-tools" },
  { a: "--system-prompt", b: "--append-system-prompt", message: "--system-prompt cannot be combined with --append-system-prompt" },
];

function isPresent(raw: RawArgs, long: string): boolean {
  const value = raw.flags.get(long);
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  return value.length > 0;
}

function checkConflicts(raw: RawArgs): Result<true> {
  for (const conflict of CONFLICTS) {
    if (isPresent(raw, conflict.a) && isPresent(raw, conflict.b)) {
      return { ok: false, reason: conflict.message };
    }
  }
  return { ok: true, value: true };
}

/** finalize 的可写构造形态（缺省先行，字段按在场覆写） */
type WritableArgs = { -readonly [K in keyof CliArgs]: CliArgs[K] };

/** 绑定 raw+args 的字段拷贝器（避免第 4 参数；value = 单值，list = 逗号切分） */
function makeCopier(raw: RawArgs, args: WritableArgs) {
  return {
    value(long: string, key: keyof CliArgs): void {
      const field = flagValue(raw, long);
      if (field !== undefined) (args[key] as string | undefined) = field;
    },
    list(long: string, key: "tools" | "excludeTools"): void {
      const field = flagValue(raw, long);
      if (field !== undefined) args[key] = splitList(field);
    },
  };
}

function checkEnums(raw: RawArgs): Result<true> {
  const mode = flagValue(raw, "--mode");
  if (mode !== undefined && mode !== "text" && mode !== "json") {
    return { ok: false, reason: `--mode: expected text | json (got "${mode}")` };
  }
  const thinking = flagValue(raw, "--thinking");
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevelCli)) {
    return { ok: false, reason: `--thinking: expected ${THINKING_LEVELS.join(" | ")} (got "${thinking}")` };
  }
  const permission = flagValue(raw, "--permission");
  if (permission !== undefined && !(MODE_KNOBS as readonly string[]).includes(permission)) {
    return { ok: false, reason: `--permission: expected ${MODE_KNOBS.join(" | ")} (got "${permission}")` };
  }
  return { ok: true, value: true };
}

/** 校验枚举闭集 + 组装最终形态（缺省在此落定） */
function finalize(raw: RawArgs): Result<CliArgs> {
  const conflicts = checkConflicts(raw);
  if (!conflicts.ok) return conflicts;
  const enums = checkEnums(raw);
  if (!enums.ok) return enums;
  const appends = raw.flags.get("--append-system-prompt");
  const args: WritableArgs = {
    print: flagBool(raw, "--print"),
    mode: (flagValue(raw, "--mode") ?? "text") as OutputMode,
    continueRecent: flagBool(raw, "--continue"),
    resume: flagBool(raw, "--resume"),
    noSession: flagBool(raw, "--no-session"),
    noTools: flagBool(raw, "--no-tools"),
    listModels: raw.flags.has("--list-models"),
    version: flagBool(raw, "--version"),
    help: flagBool(raw, "--help"),
    appendSystemPrompts: Array.isArray(appends) ? [...appends] : [],
    messages: [...raw.messages],
    fileArgs: [...raw.fileArgs],
  };
  const copy = makeCopier(raw, args);
  copy.value("--session", "session");
  copy.value("--session-dir", "sessionDir");
  copy.value("--provider", "provider");
  copy.value("--model", "model");
  const thinking = flagValue(raw, "--thinking");
  if (thinking !== undefined) args.thinking = thinking as ThinkingLevelCli;
  const permission = flagValue(raw, "--permission");
  if (permission !== undefined) args.permission = permission as ModeKnob;
  copy.value("--api-key", "apiKey");
  copy.list("--tools", "tools");
  copy.list("--exclude-tools", "excludeTools");
  copy.value("--system-prompt", "systemPrompt");
  copy.value("--list-models", "listModelsSearch");
  return { ok: true, value: args };
}
export function parseCliArgs(argv: readonly string[]): Result<CliArgs> {
  const scanned = scan(argv);
  if (!scanned.ok) return scanned;
  return finalize(scanned.value);
}

export function usageText(bin: string): string {
  return `x-harness coding agent

usage: ${bin} [flags] [message...] [@file...]

session:
  -c, --continue            resume the most recent session for this directory
  -r, --resume              pick a session to resume
  --session <id-prefix>     resume a session by id prefix
  --no-session              in-memory session (nothing is written to disk)
  --session-dir <dir>       session store root (default ~/.x-harness/sessions)

model:
  --provider <name>         override providers.json default provider
  --model <model>           override default model
  --thinking <level>        off | low | medium | high
  --api-key <key>           override the chosen provider's api key for this run
  --list-models [search]    list models from providers.json and exit

tools:
  -t, --tools <a,b,...>     tool allowlist
  -xt, --exclude-tools <a,b>  remove tools from the allowlist
  -nt, --no-tools           disable all tools

permission:
  --permission <plan|auto|full>  tool permission mode (default auto)

prompt:
  --system-prompt <text>    replace the system prompt
  --append-system-prompt <text>  append a section (repeatable)

output:
  -p, --print               non-interactive: run the initial message and exit
  --mode <text|json>        output format (json = JSONL event stream)

misc:
  --version (-v) | --help (-h) | --   everything after -- is positional
                                     @-prefixed args attach file contents to the message

config: $X_HARNESS_HOME/providers.json (default ~/.x-harness/providers.json)
exit codes: 0 ok, 1 runtime failure, 2 usage/config error`;
}
