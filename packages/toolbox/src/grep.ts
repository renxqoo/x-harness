// grep 工具（docs/TOOLBOX.md §5）：rg 硬依赖单路径（解析链 rgPath → env X_HARNESS_RG_PATH →
// PATH 探测；缺席 fail-closed 报修复指引——绝不静默降级）。纯 argv 向量注入安全；
// selfKilled 达限即停成功终态；--json 事件组装；malformed 流 fail-closed。

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { PathGate } from "./paths.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const LINE_PREVIEW = 500;
const RAW_CAP = 1_000_000;
/** 目录搜索跳过集（`--glob !node_modules --glob !.git`；不尊重 gitignore——--no-ignore 声明） */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

const RG_GUIDANCE = "install ripgrep (brew install ripgrep / apt install ripgrep), set X_HARNESS_RG_PATH, or pass rgPath to createToolbox";

export interface GrepOptions {
  readonly rgPath?: string;
}

/** rg 解析链：显式 rgPath → env X_HARNESS_RG_PATH → PATH 探测（PATH 目录不可写的信任前提落档 §7）。
 *  env/which 可注入——Bun.which 缓存启动期 PATH，运行时改 env 不生效，缺席态只能注入构造 */
export function resolveRg(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
  which: (command: string) => string | null = (command) => Bun.which(command),
): string | null {
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = env.X_HARNESS_RG_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return which("rg");
}

export function createGrepTool(gate: PathGate, options: GrepOptions = {}): ToolDefinition {
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
    execute: async (args, ctx: ToolExecContext) => grep({ gate, options, ctx, args: args as Record<string, unknown> }),
  };
}

async function grep(input: { readonly gate: PathGate; readonly options: GrepOptions; readonly ctx: ToolExecContext; readonly args: Record<string, unknown> }): Promise<{ content: string; isError?: true }> {
  const { gate, options, ctx, args } = input;
  const pattern = args["pattern"] as string;
  if (pattern.includes("\u0000")) return { content: "NUL_IN_ARGUMENT: pattern contains NUL", isError: true };
  const targetRaw = (args["path"] as string | undefined) ?? ".";
  const admitted = gate.admit(targetRaw);
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
  try {
    statSync(admitted.path); // 存在性门（目录/文件都合法——rg 自行分派）
  } catch {
    return { content: `FS_NOT_FOUND: ${targetRaw} does not exist`, isError: true };
  }
  const rg = resolveRg(options.rgPath);
  if (rg === null) {
    return { content: `SEARCH_RG_UNAVAILABLE: ripgrep is required but not found — ${RG_GUIDANCE}`, isError: true };
  }
  const search: SearchArgs = { pattern, path: admitted.path, glob, literal, ignoreCase, context, limit, signal: ctx.signal };
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
  const child = spawn(a.rgPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.kill("SIGTERM");
  };
  a.signal.addEventListener("abort", abortRg, { once: true });

  const stdout = child.stdout;
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (reached) return; // 达限闭流
    if (drainChunk(chunk)) return;
    // 流式计数达限即停（-m 是 per-file 上限不用——全局 limit 由计数实现）
    consumeCompleteLines();
  });
  const drainChunk = (chunk: string): boolean => {
    rawBytes += Buffer.byteLength(chunk);
    if (rawBytes > RAW_CAP) {
      rawOverflow = true;
      child.kill("SIGTERM");
      return true;
    }
    raw += chunk;
    return false;
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
  const stderr = child.stderr;
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-500);
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (exitCode) => resolve(exitCode));
    child.on("error", () => resolve(-1));
  });
  a.signal.removeEventListener("abort", abortRg);
  // kill 落点之后的未解析输出（同 chunk 余行、撕裂半行）直接丢弃——已解析行即终态；
  // 不做 kill 后排空：其结果在三路终态下均不可达（reached 排除、aborted/rawOverflow 优先归一）
  return settleRg({ code, selfKilled, malformed, rawOverflow, aborted: a.signal.aborted, stderrTail, matches, limit: a.limit });
}

/** 退出码矩阵：selfKilled→成功走 limit 页脚；1=零命中成功；2→FAILED（stderr 特征附 literal 提示）；
 *  malformed→FAILED（损坏流不可信——静默当零命中是假空，fail-closed） */
function settleRg(input: { readonly code: number | null; readonly selfKilled: boolean; readonly malformed: boolean; readonly rawOverflow: boolean; readonly aborted: boolean; readonly stderrTail: string; readonly matches: Array<{ path: string; line: number; text: string; isContext: boolean }>; readonly limit: number }): { content: string; isError?: true } {
  if (input.aborted) return { content: "SEARCH_ABORTED: search cancelled", isError: true };
  if (input.rawOverflow) return { content: "SEARCH_RAW_OUTPUT_OVERFLOW: rg output exceeded 1MB", isError: true };
  if (input.malformed) return { content: "SEARCH_FAILED: rg produced malformed output (stream corrupted)", isError: true };
  if (input.code === -1) return { content: `SEARCH_FAILED: failed to start rg (path may be wrong) — ${RG_GUIDANCE}`, isError: true };
  if (input.code === 1 && !input.selfKilled) return { content: "No matches found" };
  if (input.code !== 0 && input.code !== 1 && !input.selfKilled) {
    const hint = /regex|parse|unrecognized|invalid pattern/i.test(input.stderrTail) ? " (the pattern may be invalid — try literal:true)" : "";
    const tail = input.stderrTail === "" ? "" : `: ${input.stderrTail.trim()}`;
    return { content: `SEARCH_FAILED: rg exited ${String(input.code)}${tail}${hint}`, isError: true };
  }
  if (input.matches.length === 0) return { content: "No matches found" };
  return { content: renderMatches(input.matches, input.limit) };
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
