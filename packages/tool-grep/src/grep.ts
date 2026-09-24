// grep 工具（docs/TOOLBOX.md §5）：rg 硬依赖单路径（解析链 rgPath → env X_HARNESS_RG_PATH →
// rgBinDir 内置目录 → PATH 探测；缺席 fail-closed 报修复指引——绝不静默降级）。纯 argv 向量
// 注入安全；selfKilled 达限即停成功终态；--json 事件组装；malformed 流 fail-closed。

import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv } from "@x-harness/exec-env";
import { admitSession } from "@x-harness/tool-core";
import type { PathGate, RootOverrideOf, ExtraRootsOf } from "@x-harness/tool-core";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const LINE_PREVIEW = 500;
const RAW_CAP = 1_000_000;
/** 目录搜索跳过集（`--glob !node_modules --glob !.git`；不尊重 gitignore——--no-ignore 声明） */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

const RG_GUIDANCE = "install ripgrep (brew install ripgrep / apt install ripgrep), place the bundled binary under <harness home>/bin/rg (bun run fetch:rg), set X_HARNESS_RG_PATH, or pass rgPath to createGrepPlugin";

export interface GrepOptions {
  readonly rgPath?: string;
  /** 内置 rg 目录（装配方从根配置推导——harness home 的 bin/；包本身不认识任何根配置）。
   *  目录内定文件名 rg；在场（existsSync）即解析为 <dir>/rg，先于 PATH 探测。 */
  readonly rgBinDir?: string;
}

export interface ResolveRgInput {
  readonly explicit?: string;
  readonly rgBinDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly which?: (command: string) => string | null;
}

/** rg 解析链：显式 rgPath → env X_HARNESS_RG_PATH → rgBinDir 内置目录 → PATH 探测
 *  （PATH 目录不可写的信任前提落档 §7；rgBinDir 同前提——目录归属宿主数据区）。
 *  env/which 可注入——Bun.which 缓存启动期 PATH，运行时改 env 不生效，缺席态只能注入构造 */
export function resolveRg(input: ResolveRgInput): string | null {
  if (input.explicit !== undefined && input.explicit !== "") return input.explicit;
  const env = input.env ?? process.env;
  const fromEnv = env.X_HARNESS_RG_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const dir = input.rgBinDir;
  if (dir !== undefined && dir !== "" && isFile(join(dir, "rg"))) return join(dir, "rg");
  const which = input.which ?? ((command: string) => Bun.which(command));
  return which("rg");
}

/** rg 在场判定：真文件（非目录/非死链——statSync 跟随符号链接，死链 false 落 PATH）。 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface GrepToolInput {
  readonly gate: PathGate;
  readonly options: GrepOptions;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
}

export function createGrepTool(input: GrepToolInput): ToolDefinition {
  const { gate, options, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression (or literal:true for fixed strings) under a path in the workspace. Returns path:line:text matches with optional context lines. Zero matches is a successful empty result. Use read for full lines.",
    inputSchema: Type.Object({
      pattern: Type.String({ minLength: 1, description: "Search pattern (regex unless literal:true)" }),
      path: Type.Optional(Type.String({ description: "File or directory to search (default workspace root)" })),
      glob: Type.Optional(Type.String({ description: "Single positive glob filter, e.g. *.ts or *.{ts,tsx}" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a fixed string (escape hatch for regex errors)" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Context lines around each match (grep -C)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Max matches (default ${String(DEFAULT_LIMIT)}, max ${String(MAX_LIMIT)}; over-max is rejected)` })),
    }),
    isConcurrencySafe: () => true,
    execute: async (args, ctx: ToolExecContext) => grep({ gate, options, env, ctx, extraRootsOf, rootOverrideOf, args: args as Record<string, unknown> }),
  };
}

async function grep(input: { readonly gate: PathGate; readonly options: GrepOptions; readonly env: ExecEnv; readonly extraRootsOf: ExtraRootsOf; readonly rootOverrideOf?: RootOverrideOf; readonly ctx: ToolExecContext; readonly args: Record<string, unknown> }): Promise<{ content: string; isError?: true }> {
  const { gate, options, env, ctx, args, extraRootsOf, rootOverrideOf } = input;
  const pattern = args["pattern"] as string;
  if (pattern.includes("\u0000")) return { content: "NUL_IN_ARGUMENT: pattern contains NUL", isError: true };
  const targetRaw = (args["path"] as string | undefined) ?? ".";
  const admitted = await admitSession({ gate, realpath: env.realpath, session: ctx.session, extraRootsOf, rootOverrideOf, target: targetRaw });
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const glob = args["glob"] as string | undefined;
  if (glob !== undefined) {
    const invalid = globError(glob);
    if (invalid !== undefined) return { content: `INVALID_GLOB: ${invalid}`, isError: true };
    if (glob.includes("\u0000")) return { content: "NUL_IN_ARGUMENT: glob contains NUL", isError: true };
  }
  const limit = (args["limit"] as number | undefined) ?? DEFAULT_LIMIT;
  const context = (args["context"] as number | undefined) ?? 0;
  const literal = (args["literal"] as boolean | undefined) === true;
  const ignoreCase = (args["ignore_case"] as boolean | undefined) === true;
  const st = await env.stat(admitted.path); // 存在性门（目录/文件都合法——rg 自行分派）
  if (!st.ok) return { content: `FS_NOT_FOUND: ${targetRaw} does not exist`, isError: true };
  const rg = resolveRg({ explicit: options.rgPath, rgBinDir: options.rgBinDir });
  if (rg === null) {
    return { content: `SEARCH_RG_UNAVAILABLE: ripgrep is required but not found — ${RG_GUIDANCE}`, isError: true };
  }
  const search: SearchArgs = { pattern, path: admitted.path, glob, literal, ignoreCase, context, limit, signal: ctx.signal, env, session: ctx.session, exec: ctx.exec };
  return runRg({ ...search, rgPath: rg });
}

interface SearchArgs {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly literal: boolean;
  readonly ignoreCase: boolean;
  readonly context: number;
  readonly limit: number;
  readonly signal: AbortSignal;
  readonly env: ExecEnv;
  readonly session: ToolExecContext["session"];
  readonly exec?: ToolExecContext["exec"];
}

interface RgLine {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly line_number?: number;
    readonly lines?: { readonly text?: string };
  };
}

function rgArgv(a: SearchArgs): string[] {
  const argv = ["--json", "--no-config", "--no-messages", "--hidden", "--no-ignore"];
  for (const skip of SKIP_DIRS) argv.push("--glob", `!${skip}`);
  if (a.glob !== undefined) argv.push("--glob", a.glob);
  if (a.literal) argv.push("--fixed-strings");
  if (a.ignoreCase) argv.push("--ignore-case");
  if (a.context > 0) argv.push("--context", String(a.context));
  argv.push("--regexp", a.pattern, "--", a.path);
  return argv;
}

async function runRg(a: SearchArgs & { readonly rgPath: string }): Promise<{ content: string; isError?: true }> {
  const argv = rgArgv(a);
  const spawned = await a.env.spawn({ argv: [a.rgPath, ...argv], ...(a.session !== undefined ? { session: a.session } : {}), ...(a.exec !== undefined ? { exec: a.exec } : {}) });
  if (!spawned.ok) {
    // 启动失败（二进制缺席等）——与 close(-1) 同终态
    return settleRg({ code: -1, signal: null, selfKilled: false, malformed: false, rawOverflow: false, aborted: a.signal.aborted, stderrTail: spawned.reason.detail, matches: [], limit: a.limit });
  }
  const proc = spawned.proc;
  let raw = "";
  let rawBytes = 0;
  let rawOverflow = false;
  let stderrTail = "";
  let selfKilled = false;
  const matches: Array<{ path: string; line: number; text: string; isContext: boolean }> = [];

  let reached = false; // 达限后不再摄入（kill 后余量按截断处理）
  let malformed = false; // 完整行 JSON 解析失败 = 输出流损坏——fail-closed，不静默当零命中
  const abortRg = (): void => {
    selfKilled = true;
    void proc.kill("term");
  };
  a.signal.addEventListener("abort", abortRg, { once: true });

  const consumeChunk = (chunk: string): void => {
    if (reached) return; // 达限闭流
    rawBytes += Buffer.byteLength(chunk);
    if (rawBytes > RAW_CAP) {
      rawOverflow = true;
      void proc.kill("term");
      return;
    }
    raw += chunk;
    consumeCompleteLines();
  };
  const consumeCompleteLines = (): void => {
    let nl = raw.indexOf("\n");
    while (nl >= 0) {
      const line = raw.slice(0, nl);
      raw = raw.slice(nl + 1);
      if (line !== "") {
        const parsed = parseRgLine(line, matches);
        if (parsed === "malformed") malformed = true;
        if (parsed === "match" && matches.filter((m) => !m.isContext).length >= a.limit) {
          reached = true;
          abortRg();
          return; // 达限即断：同 chunk 余行不再计入（kill 后余量按截断处理）
        }
      }
      nl = raw.indexOf("\n");
    }
  };
  const pump = async (stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new StringDecoder("utf8");
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      onText(decoder.write(read.value));
    }
    onText(decoder.end());
  };
  const pumps = [pump(proc.stdout, consumeChunk), pump(proc.stderr, (text) => {
    stderrTail = `${stderrTail}${text}`.slice(-500);
  })];
  const exited = await proc.exited;
  await Promise.allSettled(pumps);
  a.signal.removeEventListener("abort", abortRg);
  await proc.settled;
  // kill 落点之后的未解析输出（同 chunk 余行、撕裂半行）直接丢弃——已解析行即终态；
  // 不做 kill 后排空：其结果在三路终态下均不可达（reached 排除、aborted/rawOverflow 优先归一）
  return settleRg({ code: exited.code, signal: exited.signal, selfKilled, malformed, rawOverflow, aborted: a.signal.aborted, stderrTail, matches, limit: a.limit });
}

/** 退出码矩阵：selfKilled→成功走 limit 页脚；1=零命中成功；2→FAILED（stderr 特征附 literal 提示）；
 *  malformed→FAILED（损坏流不可信——静默当零命中是假空，fail-closed） */
function settleRg(input: { readonly code: number | null; readonly signal: string | null; readonly selfKilled: boolean; readonly malformed: boolean; readonly rawOverflow: boolean; readonly aborted: boolean; readonly stderrTail: string; readonly matches: Array<{ path: string; line: number; text: string; isContext: boolean }>; readonly limit: number }): { content: string; isError?: true } {
  if (input.aborted) return { content: "SEARCH_ABORTED: search cancelled", isError: true };
  if (input.rawOverflow) return { content: "SEARCH_RAW_OUTPUT_OVERFLOW: rg output exceeded 1MB", isError: true };
  if (input.malformed) return { content: "SEARCH_FAILED: rg produced malformed output (stream corrupted)", isError: true };
  if (input.code === -1) return { content: `SEARCH_FAILED: failed to start rg (path may be wrong) — ${RG_GUIDANCE}`, isError: true };
  if (input.code === 1 && !input.selfKilled) return { content: "No matches found" };
  if ((input.code === null || (input.code !== 0 && input.code !== 1)) && !input.selfKilled) {
    const hint = /regex|parse|unrecognized|invalid pattern/i.test(input.stderrTail) ? " (the pattern may be invalid — try literal:true)" : "";
    const tail = input.stderrTail === "" ? "" : `: ${input.stderrTail.trim()}`;
    return { content: `SEARCH_FAILED: rg exited ${rgExitText(input)}${tail}${hint}`, isError: true };
  }
  if (input.matches.length === 0) return { content: "No matches found" };
  return { content: renderMatches(input.matches, input.limit) };
}

function rgExitText(input: { readonly code: number | null; readonly signal: string | null }): string {
  if (input.code !== null) return String(input.code);
  return `killed by ${input.signal ?? "unknown signal"}`;
}

function parseRgLine(line: string, matches: Array<{ path: string; line: number; text: string; isContext: boolean }>): "match" | "context" | "other" | "malformed" {
  let parsed: RgLine;
  try {
    parsed = JSON.parse(line) as RgLine;
  } catch {
    return "malformed"; // 完整行解析失败 = 流损坏（撕裂半行已按 \n 切除，不会到这）
  }
  if (parsed.type !== "match" && parsed.type !== "context") return "other";
  const path = parsed.data?.path?.text ?? "";
  const lineNo = parsed.data?.line_number ?? 0;
  const text = parsed.data?.lines?.text ?? "";
  if (path === "" || lineNo === 0) return "other";
  matches.push({ path, line: lineNo, text: text.replace(/\n$/, ""), isContext: parsed.type === "context" });
  return parsed.type;
}

const GLOB_EXPAND_CAP = 64;

function expandBraces(glob: string, budget: { count: number } = { count: 1 }): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  const close = glob.indexOf("}", open);
  if (close < 0) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const parts = glob.slice(open + 1, close).split(",");
  budget.count *= parts.length;
  if (budget.count > GLOB_EXPAND_CAP) return []; // 指数展开防护（顺序组 2^n 挂死）
  return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`, budget));
}

/** glob 校验：顶层逗号拒（brace 内放行）；负向拒；指数展开帽 */
function globError(glob: string): string | undefined {
  if (glob.startsWith("!")) return "negative globs are not supported";
  let depth = 0;
  for (const ch of glob) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) return "top-level comma lists are not supported; use brace alternation like *.{ts,tsx}";
  }
  if (expandBraces(glob).length === 0) return "glob expands to too many alternatives (max 64)";
  return undefined;
}

function renderMatches(matches: Array<{ path: string; line: number; text: string; isContext: boolean }>, limit: number): string {
  const rows = matches.map((m) => {
    const text = m.text.length > LINE_PREVIEW ? `${m.text.slice(0, LINE_PREVIEW)} (line truncated, use read for full line)` : m.text;
    return m.isContext ? `${m.path}-${String(m.line)}-${text}` : `${m.path}:${String(m.line)}:${text}`;
  });
  const direct = matches.filter((m) => !m.isContext).length;
  const header = direct >= limit ? `Found ${String(direct)} matches (limit ${String(limit)} reached). Use limit=${String(Math.min(limit * 2, MAX_LIMIT))} for more, or refine the pattern` : `Found ${String(direct)} matches`;
  return [header, ...rows].join("\n");
}

export { parseRgLine, settleRg };
