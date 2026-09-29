import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ExecEnv } from "@x-harness/exec-env";
import { admitSession } from "@x-harness/tool-core";
import type { PathGate, RootOverrideOf, ExtraRootsOf } from "@x-harness/tool-core";
import { runRg, type SearchArgs, type OutputMode } from "./run-rg.ts";
import { resolveRg, type GrepOptions } from "./resolve-rg.ts";
import { globError } from "./glob.ts";
import { searchTimeoutOf } from "./timeout.ts";

const DEFAULT_HEAD_LIMIT = 100;
const MAX_HEAD_LIMIT = 1_000;
const MAX_OFFSET = 100_000;

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
    kind: "Read",
    readsSubtree: (args: unknown) => {
      const path = (args as { path?: unknown }).path;
      return path === undefined || (typeof path === "string" && path !== "" && !/\.[A-Za-z0-9]{1,8}$/.test(path));
    },
    description:
      "Search file contents with a regular expression (or literal:true for fixed strings) under a path in the workspace. output_mode: files_with_matches (default) lists files with matches sorted by recent modification; content returns path:line:text with optional context lines; count returns per-file match counts. head_limit caps results (default 100), offset skips ahead for pagination. Zero matches is a successful empty result. Use read for full lines.",
    inputSchema: Type.Object({
      pattern: Type.String({ minLength: 1, description: "Search pattern (regex unless literal:true)" }),
      path: Type.Optional(Type.String({ description: "File or directory to search (default workspace root)" })),
      glob: Type.Optional(Type.String({ description: "Single positive glob filter, e.g. *.ts or *.{ts,tsx}" })),
      type: Type.Optional(Type.String({ description: "File type filter (rg --type), e.g. ts, js, py, rust, go. Faster than glob for standard types" })),
      multiline: Type.Optional(Type.Boolean({ description: "Multiline mode: . matches newlines and patterns can span lines (rg -U --multiline-dotall)" })),
      output_mode: Type.Optional(Type.Union([Type.Literal("files_with_matches"), Type.Literal("content"), Type.Literal("count")], { description: "files_with_matches (default): file paths, mtime-newest first; content: path:line:text rows; count: path:match-count rows" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a fixed string (escape hatch for regex errors)" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Context lines around each match (content mode only, grep -C)" })),
      head_limit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_HEAD_LIMIT, description: `Max entries to return (default ${String(DEFAULT_HEAD_LIMIT)}; 0 = unlimited). Paginate with offset` })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "Skip first N entries before applying head_limit" })),
    }),
    isConcurrencySafe: () => true,
    execute: async (args, ctx: ToolExecContext) => grep({ gate, options, env, ctx, extraRootsOf, rootOverrideOf, args: args as Record<string, unknown> }),
  };
}

export async function grep(input: { readonly gate: PathGate; readonly options: GrepOptions; readonly env: ExecEnv; readonly extraRootsOf: ExtraRootsOf; readonly rootOverrideOf?: RootOverrideOf; readonly ctx: ToolExecContext; readonly args: Record<string, unknown> }): Promise<{ content: string; isError?: true }> {
  const { gate, options, env, ctx, args, extraRootsOf, rootOverrideOf } = input;
  const pattern = args["pattern"] as string;
  const targetRaw = (args["path"] as string | undefined) ?? ".";
  const admitted = await admitSession({ gate, realpath: env.realpath, session: ctx.session, extraRootsOf, rootOverrideOf, target: targetRaw });
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const parsed = parseSearchArgs(args);
  if (typeof parsed === "string") return { content: parsed, isError: true };
  const st = await env.stat(admitted.path);
  if (!st.ok) return { content: `FS_NOT_FOUND: ${targetRaw} does not exist`, isError: true };
  const rg = resolveRg({ explicit: options.rgPath, rgBinDir: options.rgBinDir });
  if (rg === null) {
    return { content: `SEARCH_RG_UNAVAILABLE: ripgrep is required but not found — install ripgrep (brew install ripgrep / apt install ripgrep), place the bundled binary under <harness home>/bin/rg (bun run fetch:rg), set X_HARNESS_RG_PATH, or pass rgPath to createGrepPlugin`, isError: true };
  }
  const search: SearchArgs = { pattern, path: admitted.path, ...parsed, signal: ctx.signal, env, session: ctx.session, exec: ctx.exec };
  return runRg({ ...search, rgPath: rg, timeoutMs: searchTimeoutOf() });
}

function parseSearchArgs(args: Record<string, unknown>): { readonly glob?: string; readonly type?: string; readonly multiline: boolean; readonly outputMode: OutputMode; readonly literal: boolean; readonly ignoreCase: boolean; readonly context: number; readonly headLimit: number; readonly offset: number } | string {
  const invalid = argError(args);
  if (invalid !== undefined) return invalid;
  const glob = args["glob"] as string | undefined;
  const type = args["type"] as string | undefined;
  const outputModeRaw = args["output_mode"] as string | undefined;
  const outputMode: OutputMode = outputModeRaw === "content" || outputModeRaw === "count" ? outputModeRaw : "files_with_matches";
  return {
    ...(glob !== undefined ? { glob } : {}),
    ...(type !== undefined && type !== "" ? { type } : {}),
    multiline: (args["multiline"] as boolean | undefined) === true,
    outputMode,
    literal: (args["literal"] as boolean | undefined) === true,
    ignoreCase: (args["ignore_case"] as boolean | undefined) === true,
    context: (args["context"] as number | undefined) ?? 0,
    headLimit: (args["head_limit"] as number | undefined) ?? DEFAULT_HEAD_LIMIT,
    offset: (args["offset"] as number | undefined) ?? 0,
  };
}

function argError(args: Record<string, unknown>): string | undefined {
  const pattern = args["pattern"];
  if (typeof pattern === "string" && pattern.includes("\u0000")) return "NUL_IN_ARGUMENT: pattern contains NUL";
  const glob = args["glob"];
  if (typeof glob === "string") {
    const invalid = globError(glob);
    if (invalid !== undefined) return `INVALID_GLOB: ${invalid}`;
    if (glob.includes("\u0000")) return "NUL_IN_ARGUMENT: glob contains NUL";
  }
  const type = args["type"];
  if (typeof type === "string" && type.includes("\u0000")) return "NUL_IN_ARGUMENT: type contains NUL";
  return undefined;
}

export { DEFAULT_HEAD_LIMIT, MAX_HEAD_LIMIT };
