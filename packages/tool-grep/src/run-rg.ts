import { StringDecoder } from "node:string_decoder";
import type { ExecEnv } from "@x-harness/exec-env";
import type { ToolExecContext } from "@x-harness/tools";

export type OutputMode = "files_with_matches" | "content" | "count";

export interface SearchArgs {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly type?: string;
  readonly multiline: boolean;
  readonly outputMode: OutputMode;
  readonly literal: boolean;
  readonly ignoreCase: boolean;
  readonly context: number;
  readonly headLimit: number;
  readonly offset: number;
  readonly signal: AbortSignal;
  readonly env: ExecEnv;
  readonly session: ToolExecContext["session"];
  readonly exec?: ToolExecContext["exec"];
}

export interface MatchRow {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly isContext: boolean;
  readonly truncated: boolean;
}

export interface RgLine {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly line_number?: number;
    readonly lines?: { readonly text?: string; readonly bytes?: string };
  };
}

export const LINE_PREVIEW = 500;
export const EVENT_LINE_BYTES_CAP = 1_000_000;
export const STREAM_BYTES_CAP = 64_000_000;
export const TRUNC_TAIL = "[some matching lines were too large to include; use read with the paths above]";
export const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

export function rgArgv(a: SearchArgs): string[] {
  const argv = ["--json", "--no-config", "--no-messages", "--hidden", "--no-ignore"];
  for (const skip of SKIP_DIRS) argv.push("--glob", `!${skip}`);
  if (a.glob !== undefined) argv.push("--glob", a.glob);
  if (a.type !== undefined) argv.push("--type", a.type);
  if (a.literal) argv.push("--fixed-strings");
  if (a.ignoreCase) argv.push("--ignore-case");
  if (a.multiline) argv.push("--multiline", "--multiline-dotall");
  if (a.context > 0 && a.outputMode === "content") argv.push("--context", String(a.context));
  argv.push("--regexp", a.pattern, "--", a.path);
  return argv;
}

export function parseRgLine(line: string, matches: MatchRow[], previewCap: number): "match" | "context" | "other" | "malformed" {
  let parsed: RgLine;
  try {
    parsed = JSON.parse(line) as RgLine;
  } catch {
    return "malformed";
  }
  if (parsed.type !== "match" && parsed.type !== "context") return "other";
  const path = parsed.data?.path?.text ?? "";
  const lineNo = parsed.data?.line_number ?? 0;
  const rawText = lineTextOf(parsed);
  if (path === "" || lineNo === 0 || rawText === undefined) return "other";
  const text = rawText.replace(/\n$/, "");
  if (text === "") {
    matches.push({ path, line: lineNo, text: "", isContext: parsed.type === "context", truncated: false });
    return parsed.type;
  }
  if (text.length <= previewCap) {
    matches.push({ path, line: lineNo, text, isContext: parsed.type === "context", truncated: false });
    return parsed.type;
  }
  matches.push({ path, line: lineNo, text: safeSlice(text, previewCap), isContext: parsed.type === "context", truncated: true });
  return parsed.type;
}

function lineTextOf(parsed: RgLine): string | undefined {
  if (parsed.data?.lines?.text !== undefined) return parsed.data.lines.text;
  const b64 = parsed.data?.lines?.bytes;
  if (b64 === undefined) return undefined;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function safeSlice(text: string, cap: number): string {
  const head = text.slice(0, cap);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return head.slice(0, -1);
  return head;
}

export async function runRg(a: SearchArgs & { readonly rgPath: string; readonly timeoutMs: number }): Promise<{ content: string; isError?: true }> {
  const argv = rgArgv(a);
  const spawned = await a.env.spawn({ argv: [a.rgPath, ...argv], ...(a.session !== undefined ? { session: a.session } : {}), ...(a.exec !== undefined ? { exec: a.exec } : {}) });
  if (!spawned.ok) {
    return settleRg({ code: -1, signal: null, selfKilled: false, malformed: false, rawOverflow: false, timedOut: false, longLineDropped: false, aborted: a.signal.aborted, stderrTail: spawned.reason.detail, matches: [], limit: a.headLimit, offset: a.offset, context: a.context, outputMode: a.outputMode, env: a.env, root: a.env.root });
  }
  const proc = spawned.proc;
  let pending = "";
  let streamBytes = 0;
  let rawOverflow = false;
  let timedOut = false;
  let longLineDropped = false;
  let stderrTail = "";
  let selfKilled = false;
  const matches: MatchRow[] = [];

  let reached = false;
  let malformed = false;
  let skipToNewline = false;
  const deadline = Date.now() + a.timeoutMs;
  const abortRg = (): void => {
    selfKilled = true;
    void proc.kill("term");
  };
  const onTimeout = (): void => {
    timedOut = true;
    void proc.kill("term");
  };
  const timer: ReturnType<typeof setTimeout> = setTimeout(onTimeout, a.timeoutMs);
  a.signal.addEventListener("abort", abortRg, { once: true });

  const collectCap = a.outputMode === "content" ? contentCollectCapOf(a.headLimit, a.offset) : STREAM_COLLECT_ALL;
  const ingest = (line: string): void => {
    if (line === "") return;
    const parsed = parseRgLine(line, matches, LINE_PREVIEW);
    if (parsed === "malformed") malformed = true;
    const direct = matches.filter((m) => !m.isContext).length;
    if (direct >= collectCap) {
      reached = true;
      abortRg();
    }
  };

  const consumeChunk = (chunk: string): void => {
    if (reached) return;
    streamBytes += Buffer.byteLength(chunk);
    if (streamBytes > STREAM_BYTES_CAP) {
      rawOverflow = true;
      void proc.kill("term");
      return;
    }
    pending += chunk;
    if (skipToNewline) {
      const nl = pending.indexOf("\n");
      if (nl < 0) {
        pending = "";
        return;
      }
      pending = pending.slice(nl + 1);
      skipToNewline = false;
    }
    for (;;) {
      if (reached) return;
      const nl = pending.indexOf("\n");
      if (nl < 0) break;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (Buffer.byteLength(line) > EVENT_LINE_BYTES_CAP) {
        longLineDropped = true;
        continue;
      }
      ingest(line);
    }
    if (Buffer.byteLength(pending) > EVENT_LINE_BYTES_CAP) {
      pending = "";
      longLineDropped = true;
      skipToNewline = true;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      void proc.kill("term");
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
  clearTimeout(timer);
  a.signal.removeEventListener("abort", abortRg);
  await proc.settled;
  return settleRg({ code: exited.code, signal: exited.signal, selfKilled, malformed, rawOverflow, timedOut, longLineDropped, aborted: a.signal.aborted, stderrTail, matches, limit: a.headLimit, offset: a.offset, context: a.context, outputMode: a.outputMode, env: a.env, root: a.env.root });
}

const STREAM_COLLECT_ALL = 2_000_000;
const CONTENT_COLLECT_CAP = 50_000;

function contentCollectCapOf(headLimit: number, offset: number): number {
  const windowNeed = headLimit === 0 ? CONTENT_COLLECT_CAP : offset + headLimit * (2 * 5 + 1);
  return Math.min(Math.max(windowNeed, headLimit === 0 ? 0 : offset + headLimit), CONTENT_COLLECT_CAP);
}

function settleRg(input: { readonly code: number | null; readonly signal: string | null; readonly selfKilled: boolean; readonly malformed: boolean; readonly rawOverflow: boolean; readonly timedOut: boolean; readonly longLineDropped: boolean; readonly aborted: boolean; readonly stderrTail: string; readonly matches: MatchRow[]; readonly limit: number; readonly offset: number; readonly context: number; readonly outputMode: OutputMode; readonly env: ExecEnv; readonly root: string }): Promise<{ content: string; isError?: true }> {
  const failed = rgFailure(input);
  if (failed !== undefined) return Promise.resolve(failed);
  if (input.matches.length === 0) return Promise.resolve({ content: noMatchesText(input.longLineDropped) });
  return render({ ...input });
}

function rgFailure(input: { readonly code: number | null; readonly signal: string | null; readonly selfKilled: boolean; readonly malformed: boolean; readonly rawOverflow: boolean; readonly timedOut: boolean; readonly longLineDropped: boolean; readonly aborted: boolean; readonly stderrTail: string }): { content: string; isError?: true } | undefined {
  if (input.aborted) return { content: "SEARCH_ABORTED: search cancelled", isError: true };
  if (input.timedOut) return { content: "SEARCH_TIMED_OUT: search exceeded 30s — narrow the search (path, glob, or a more specific pattern)", isError: true };
  if (input.rawOverflow) return { content: `SEARCH_RAW_OUTPUT_OVERFLOW: rg output exceeded ${String(STREAM_BYTES_CAP)} bytes — narrow the search (glob, path, or a more specific pattern)`, isError: true };
  if (input.malformed) return { content: "SEARCH_FAILED: rg produced malformed output (stream corrupted)", isError: true };
  if (input.code === -1) return { content: "SEARCH_FAILED: failed to start rg (path may be wrong) — install ripgrep (brew install ripgrep / apt install ripgrep), place the bundled binary under <harness home>/bin/rg (bun run fetch:rg), set X_HARNESS_RG_PATH, or pass rgPath to createGrepPlugin", isError: true };
  if (input.code === 1 && !input.selfKilled) return { content: noMatchesText(input.longLineDropped) };
  if (input.code === null || (input.code !== 0 && input.code !== 1)) {
    if (input.selfKilled) return undefined;
    const hint = /regex|parse|unrecognized|invalid pattern/i.test(input.stderrTail) ? " (the pattern may be invalid — try literal:true)" : "";
    const tail = input.stderrTail === "" ? "" : `: ${input.stderrTail.trim()}`;
    return { content: `SEARCH_FAILED: rg exited ${rgExitText(input)}${tail}${hint}`, isError: true };
  }
  return undefined;
}

function noMatchesText(longLineDropped: boolean): string {
  return longLineDropped ? `No matches found\n${TRUNC_TAIL}` : "No matches found";
}

function rgExitText(input: { readonly code: number | null; readonly signal: string | null }): string {
  if (input.code !== null) return String(input.code);
  return `killed by ${input.signal ?? "unknown signal"}`;
}

async function render(input: { readonly matches: MatchRow[]; readonly limit: number; readonly offset: number; readonly context: number; readonly outputMode: OutputMode; readonly longLineDropped: boolean; readonly env: ExecEnv; readonly root: string }): Promise<{ content: string }> {
  if (input.outputMode === "files_with_matches") return renderFilesMode(input);
  if (input.outputMode === "count") return renderCountMode(input);
  return renderContentMode(input);
}

function displayPath(path: string, root: string): string {
  if (path === root) return ".";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

async function renderFilesMode(input: { readonly matches: MatchRow[]; readonly limit: number; readonly offset: number; readonly env: ExecEnv; readonly longLineDropped: boolean; readonly root: string }): Promise<{ content: string }> {
  const seen = new Map<string, number>();
  for (const m of input.matches) {
    if (m.isContext) continue;
    seen.set(m.path, (seen.get(m.path) ?? 0) + 1);
  }
  const stats = await Promise.allSettled([...seen.keys()].map((p) => input.env.stat(p)));
  const scored = [...seen.keys()].map((path, i) => {
    const s = stats[i];
    if (s === undefined || s.status !== "fulfilled" || !s.value.ok) return { path, mtime: 0, hits: seen.get(path) ?? 0 };
    return { path, mtime: Number(s.value.stat.version.mtimeNs), hits: seen.get(path) ?? 0 };
  });
  scored.sort((x, y) => y.mtime - x.mtime || comparePath(x.path, y.path));
  const page = paginate(scored, input.limit, input.offset);
  const head = `Found ${String(seen.size)} ${seen.size === 1 ? "file" : "files"} with matches`;
  const rows = page.items.map((s) => `${displayPath(s.path, input.root)} (${String(s.hits)} ${s.hits === 1 ? "match" : "matches"})`);
  return { content: [head, ...rows, ...page.tails, ...(input.longLineDropped ? [TRUNC_TAIL] : [])].filter((line) => line !== "").join("\n") };
}

function renderCountMode(input: { readonly matches: MatchRow[]; readonly limit: number; readonly offset: number; readonly longLineDropped: boolean; readonly root: string }): { content: string } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const m of input.matches) {
    if (m.isContext) continue;
    counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
    total += 1;
  }
  const entries = [...counts.entries()].map(([path, count]) => ({ path, count }));
  entries.sort((x, y) => y.count - x.count || comparePath(x.path, y.path));
  const page = paginate(entries, input.limit, input.offset);
  const files = counts.size;
  const head = `Found ${String(total)} ${total === 1 ? "match" : "matches"} across ${String(files)} ${files === 1 ? "file" : "files"}`;
  const rows = page.items.map((e) => `${displayPath(e.path, input.root)}:${String(e.count)}`);
  return { content: [head, ...rows, ...page.tails, ...(input.longLineDropped ? [TRUNC_TAIL] : [])].filter((line) => line !== "").join("\n") };
}

function renderContentMode(input: { readonly matches: MatchRow[]; readonly limit: number; readonly offset: number; readonly context: number; readonly longLineDropped: boolean; readonly root: string }): { content: string } {
  const sorted = [...input.matches].sort((x, y) => comparePath(x.path, y.path) || x.line - y.line);
  const total = sorted.filter((m) => !m.isContext).length;
  const endMatch = input.limit === 0 ? total : Math.min(input.offset + input.limit, total);
  const kept: MatchRow[] = [];
  let matchIndex = -1;
  let pendingContext: MatchRow[] = [];
  for (const m of sorted) {
    if (!m.isContext) {
      matchIndex += 1;
      if (matchIndex >= input.offset && matchIndex < endMatch) {
        kept.push(...pendingContext, m);
      }
      pendingContext = [];
      if (matchIndex >= endMatch && endMatch <= total) break;
    } else if (matchIndex >= input.offset && matchIndex < endMatch) {
      kept.push(m);
    } else {
      pendingContext.push(m);
    }
  }
  const rows = kept.map((m) => {
    const text = m.truncated ? `${m.text} (line truncated, use read for full line)` : m.text;
    const path = displayPath(m.path, input.root);
    return m.isContext ? `${path}-${String(m.line)}-${text}` : `${path}:${String(m.line)}:${text}`;
  });
  const head = `Found ${String(total)} ${total === 1 ? "match" : "matches"}`;
  const tails = [...(endMatch < total || input.offset > 0 ? [`[Showing results with pagination = limit: ${String(input.limit)}, offset: ${String(input.offset)}]`] : []), ...(input.longLineDropped ? [TRUNC_TAIL] : [])];
  return { content: [head, ...rows, ...tails].join("\n") };
}

function paginate<T>(items: T[], limit: number, offset: number): { items: T[]; tails: string[] } {
  if (limit === 0) return { items: items.slice(offset), tails: offset > 0 ? [`[Showing results with pagination = limit: 0, offset: ${String(offset)}]`] : [] };
  const sliced = items.slice(offset, offset + limit);
  const tails = items.length - offset > limit ? [`[Showing results with pagination = limit: ${String(limit)}, offset: ${String(offset)}]`] : [];
  return { items: sliced, tails };
}

export { settleRg };

function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
