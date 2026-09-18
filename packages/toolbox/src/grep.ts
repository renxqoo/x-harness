// grep 工具（docs/TOOLBOX.md §5）：双路径（系统 rg / JS walker 回退）；纯 argv 向量注入安全；
// selfKilled 达限即停成功终态；--json 事件组装；两路径同输出形状。

import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { readdirSync, readSync, openSync, closeSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { PathGate } from "./paths.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const LINE_PREVIEW = 500;
const RAW_CAP = 1_000_000;
/** 双路径共享跳过集（rg --glob 与 walker 同表——放弃 gitignore 换一致性） */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface GrepOptions {
  readonly rgPath?: string;
  /** 显式禁用 rg 强制 walker 路径（测试对齐装置/无 rg 环境逃生口） */
  readonly disableRg?: boolean;
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
  let st: Stats;
  try {
    st = statSync(admitted.path);
  } catch {
    return { content: `FS_NOT_FOUND: ${targetRaw} does not exist`, isError: true };
  }

  const search: SearchArgs = { pattern, path: admitted.path, isFile: st.isFile(), glob, literal, ignoreCase, context, limit, signal: ctx.signal };
  if (options.disableRg !== true) {
    const rg = options.rgPath ?? whichRg();
    if (rg !== null && rg !== "") return runRg({ ...search, rgPath: rg as string });
  }
  return walk(search);
}

function whichRg(): string | null {
  return Bun.which("rg");
}

// ---------- rg 路径 ----------

interface SearchArgs {
  readonly pattern: string;
  readonly path: string;
  readonly isFile: boolean;
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
  // kill 后排空：残余 buffer 的完整行继续解析；无尾换行的末段是撕裂半行——记截断不记损坏
  if (raw !== "" && !reached) {
    if (raw.endsWith("\n") || selfKilled) {
      const lines = raw.split("\n");
      if (!raw.endsWith("\n")) lines.pop();
      for (const line of lines) {
        if (line === "" || reached) continue;
        if (parseRgLine(line, matches) === "malformed") malformed = true;
      }
    }
  }
  const settled = settleRg({ code, selfKilled, malformed, rawOverflow, aborted: a.signal.aborted, stderrTail, matches, limit: a.limit });
  return settled;
}

/** 退出码矩阵：selfKilled→成功走 limit 页脚；1=零命中成功；2→FAILED（stderr 特征附 literal 提示）；
 *  malformed→FAILED（损坏流不可信——静默当零命中是假空，fail-closed） */
function settleRg(input: { readonly code: number | null; readonly selfKilled: boolean; readonly malformed: boolean; readonly rawOverflow: boolean; readonly aborted: boolean; readonly stderrTail: string; readonly matches: Array<{ path: string; line: number; text: string; isContext: boolean }>; readonly limit: number }): { content: string; isError?: true } {
  if (input.aborted) return { content: "SEARCH_ABORTED: search cancelled", isError: true };
  if (input.rawOverflow) return { content: "SEARCH_RAW_OUTPUT_OVERFLOW: rg output exceeded 1MB", isError: true };
  if (input.malformed) return { content: "SEARCH_FAILED: rg produced malformed output (stream corrupted)", isError: true };
  if (input.code === -1) return { content: "SEARCH_FAILED: failed to start rg", isError: true };
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

// ---------- walker 路径 ----------

/** 目录收集（BFS；跳过共享跳过集与一切 symlink；单条目失败跳过不杀遍历）。
 *  全同步单宏任务——abort 观测不到中途态，入口由 dispatch 管线拦截 */
function collectFiles(a: SearchArgs): string[] {
  if (a.isFile) return [a.path]; // 单文件目标：不做目录遍历
  const files: string[] = [];
  const queue: string[] = [a.path];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
      } else if (entry.isFile()) {
        if (a.glob !== undefined && !globMatch(a.glob, relativeToRoot(a, full))) continue; // 相对路径匹配（与 rg 对齐）
        files.push(full);
      }
      // symlink：跳过一切（与 rg 默认一致）
    }
  }
  return files;
}

interface ScanFileInput {
  readonly file: string;
  readonly lines: readonly string[];
  readonly matcher: (line: string) => boolean;
  readonly context: number;
  readonly limit: number;
}

/** 单文件命中（含上下文行展开；计满即停不补尾 context——两路径同形状） */
function scanFile(input: ScanFileInput, matches: Array<{ path: string; line: number; text: string; isContext: boolean }>): "full" | "more" {
  const { file, lines, matcher, context, limit } = input;
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matcher(lines[i] as string)) hits.push(i + 1);
  }
  for (const hit of hits) {
    if (matches.filter((m) => !m.isContext).length >= limit) return "full";
    const start = Math.max(1, hit - context);
    const end = Math.min(lines.length, hit + context);
    for (let n = start; n <= end; n++) {
      if (matches.some((m) => m.path === file && m.line === n)) continue;
      matches.push({ path: file, line: n, text: lines[n - 1] as string, isContext: !hits.includes(n) }); // 自身命中永远是 match 行（rg 同款；context 重叠不降级）
    }
  }
  return "more";
}

async function walk(a: SearchArgs): Promise<{ content: string; isError?: true }> {
  const matcher = compileMatcher(a.pattern, a.literal, a.ignoreCase);
  if (matcher === undefined) {
    return { content: "SEARCH_INVALID_PATTERN: cannot compile pattern (try literal:true)", isError: true };
  }
  const files = collectFiles(a);
  const matches: Array<{ path: string; line: number; text: string; isContext: boolean }> = [];
  for (const file of files) {
    const lines = readTextLines(file);
    if (lines === undefined) continue; // 二进制（首 8KB NUL）/超大/读失败跳过
    if (scanFile({ file, lines, matcher, context: a.context, limit: a.limit }, matches) === "full") break;
  }
  if (matches.length === 0) return { content: "No matches found" };
  return { content: renderMatches(matches, a.limit) };
}

const WALKER_FILE_CAP = 32 * 1024 * 1024;

function readTextLines(file: string): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const head = Buffer.alloc(8_192);
    const headRead = readSync(fd, head, 0, head.length, 0);
    if (head.subarray(0, headRead).includes(0)) return undefined; // 二进制跳过
    const st = fstatSize(fd);
    if (st > WALKER_FILE_CAP) return undefined; // 大文件跳过（整读 OOM 防护——rg 路径无此限）
    const all = Buffer.alloc(st);
    let done = 0;
    while (done < st) {
      const read = readSync(fd, all, done, st - done, done);
      if (read === 0) break;
      done += read;
    }
    return all.toString("utf8", 0, done).split("\n").map((line) => line.replace(/\r$/, ""));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function fstatSize(fd: number): number {
  const st = fstatSync(fd);
  return Number(st.size);
}

// ---------- 共享 ----------

function compileMatcher(pattern: string, literal: boolean, ignoreCase: boolean): ((line: string) => boolean) | undefined {
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    const re = new RegExp(source, ignoreCase ? "i" : "");
    return (line: string) => re.test(line);
  } catch {
    return undefined;
  }
}

/** 简单 glob：* 与 {a,b} 交替（与 rg -g 子集对齐；brace-aware 逗号校验在入口） */
function globMatch(glob: string, name: string): boolean {
  const expanded = expandBraces(glob);
  return expanded.some((alt) => globToRe(alt).test(name));
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

function globToRe(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "[:doublestar:]")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/:doublestar:/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function relativeToRoot(a: SearchArgs, full: string): string {
  const root = a.path;
  const rel = full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
  return rel;
}

/** glob 校验：顶层逗号拒（brace 内放行）；负向拒 */
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

export { SKIP_DIRS, globMatch, parseRgLine, settleRg };
