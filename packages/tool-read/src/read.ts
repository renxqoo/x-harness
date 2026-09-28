// read 工具（docs/TOOLBOX.md §2 + docs/EXEC-ENV.md §3）：ExecEnv 异步流式（绝不整读）；
// 2000 行/50KB 渲染字节双限；行号连续；行动型页脚；二进制首 8KB 嗅探；!isFile 全拒。
// 观察版本取自 openRead 的 fd 版本（D2 修复：版本与内容同 inode——stat/open 竞态免疫），
// 登记先于空文件/越界分支（空文件也是有效观察）。

import { StringDecoder } from "node:string_decoder";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { ReadFace, ReadHandle } from "@x-harness/exec-env";
import { admitSession } from "@x-harness/tool-core";
import type { PathGate, RootOverrideOf, ExtraRootsOf, ObservedRegistry } from "@x-harness/tool-core";

const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 2_000;
const BYTE_BUDGET = 50_000;
const BINARY_SNIFF = 8_192;
const LINE_TRUNCATE = 2_000;
const BOM = "﻿";
/** 批量形态上限（TURN-REDUCTION §1.1A）：单轮最多 8 文件；聚合预算仍 = 单文件
 *  BYTE_BUDGET（防单轮巨量回灌——预算在工具层自截，不依赖调度层截断兜底）。 */
const MAX_BATCH = 8;

interface ReadWindow {
  readonly rendered: string[];
  readonly shownLines: number;
  readonly totalLines: number;
  readonly byteCapped: boolean;
  /** 本窗口的渲染字节预算（批量模式为剩余额度——页脚文案如实反映） */
  readonly budgetBytes: number;
  readonly firstLine: number;
  readonly lastShown: number;
}

/** io_error 哨兵：环境面 I/O 错误统一折叠为 FS_READ_FAILED，不让 dispatch 吞成 internal */
class ReadIoError extends Error {}

function openFailText(reason: "not_found" | "not_regular" | "access_denied", display: string): string {
  if (reason === "access_denied") return `FS_ACCESS_DENIED: ${display} is not readable`;
  if (reason === "not_found") return `FS_NOT_FOUND: ${display} does not exist`;
  return `FS_NOT_REGULAR_FILE: ${display} is not a regular file; use grep to explore directories`;
}

async function readChunk(handle: ReadHandle): Promise<Uint8Array | null> {
  const chunk = await handle.read();
  if (!chunk.ok) throw new ReadIoError();
  return chunk.data;
}

export interface ReadToolInput {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ReadFace;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
}

export function createReadTool(input: ReadToolInput): ToolDefinition {
  const { gate, observed, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  return {
    name: "read",
    kind: "Read",
    description:
      "Read a text file within the workspace root. Returns numbered lines (offset/limit window, default and max 2000 lines, 50KB byte budget). Long lines are truncated. Use the footer's offset hint to continue reading.",
    inputSchema: Type.Object({
      path: Type.Optional(Type.String({ description: "Single file path (relative to workspace root or absolute inside it)" })),
      paths: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: MAX_BATCH, description: `Multiple file paths (${String(MAX_BATCH)} max) read in one call; excludes offset/limit` })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to start from (single path only)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Max lines (default and cap ${String(DEFAULT_LIMIT)}; single path only)` })),
    }),
    isConcurrencySafe: () => true,
    execute: async (args, ctx: ToolExecContext) =>
      executeRead({ gate, observed, env, ctx, extraRootsOf, rootOverrideOf, args: args as { path?: string; paths?: string[]; offset?: number; limit?: number } }),
  };
}

/** 入口分派：path 与 paths 互斥（TypeBox 表达不了 XOR——判定在 execute 层，
 *  dispatch 先 schema 后 execute）；批量走聚合预算路径，单路径走既有窗口路径。 */
async function executeRead(input: {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ReadFace;
  readonly extraRootsOf: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly ctx: ToolExecContext;
  readonly args: { path?: string; paths?: string[]; offset?: number; limit?: number };
}): Promise<{ content: string; isError?: true }> {
  const { args } = input;
  const hasPath = typeof args.path === "string";
  const hasPaths = Array.isArray(args.paths);
  if (hasPath && hasPaths) return { content: "read accepts either path or paths, not both", isError: true };
  if (!hasPath && !hasPaths) return { content: "read requires path or paths", isError: true };
  if (hasPaths && (args.offset !== undefined || args.limit !== undefined)) {
    return { content: "paths batch does not accept offset/limit; re-read a single path to continue reading", isError: true };
  }
  if (hasPaths) return readBatch({ ...input, paths: args.paths ?? [] });
  return readFile({ ...input, args: { path: args.path ?? "", offset: args.offset, limit: args.limit } });
}

/** 批量读取：逐文件 <file path> 包裹块（与单路径裸输出刻意不同——两形态各自稳定）；
 *  聚合预算 50KB 逐文件先到先得，预算耗尽的文件块给行动型续读指引；
 *  部分成功语义：单文件失败仅该块错误文案，整体 isError 仅当全部失败。 */
async function readBatch(input: {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ReadFace;
  readonly extraRootsOf: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly ctx: ToolExecContext;
  readonly paths: readonly string[];
}): Promise<{ content: string; isError?: true }> {
  const { gate, observed, env, ctx, extraRootsOf, rootOverrideOf, paths } = input;
  let budget = BYTE_BUDGET;
  const blocks: string[] = [];
  let failures = 0;
  for (const target of paths) {
    if (budget <= 0) {
      blocks.push(`<file path="${target}">(budget exhausted in this batch; re-read with single path to continue)</file>`);
      failures += 1;
      continue;
    }
    const one = await readFile({ gate, observed, env, ctx, extraRootsOf, rootOverrideOf, args: { path: target }, byteBudget: budget });
    if (one.isError === true) {
      failures += 1;
      blocks.push(`<file path="${target}">${one.content}</file>`);
      continue;
    }
    budget -= Buffer.byteLength(one.content);
    blocks.push(`<file path="${target}">\n${one.content}\n</file>`);
  }
  const content = blocks.join("\n");
  return failures === paths.length ? { content, isError: true } : { content };
}

async function readFile(input: {
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ReadFace;
  readonly extraRootsOf: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
  readonly ctx: ToolExecContext;
  readonly args: { path: string; offset?: number; limit?: number };
  /** 批量模式传入剩余预算（单路径缺省 = BYTE_BUDGET）——聚合预算在调用方扣减 */
  readonly byteBudget?: number;
}): Promise<{ content: string; isError?: true }> {
  const { gate, observed, env, ctx, args, extraRootsOf, rootOverrideOf } = input;
  const admitted = await admitSession({ gate, realpath: env.realpath, session: ctx.session, extraRootsOf, rootOverrideOf, target: args.path });
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const path = admitted.path;
  const st = await env.stat(path);
  if (!st.ok) {
    return { content: st.reason === "access_denied" ? `FS_ACCESS_DENIED: ${args.path} is not readable` : `FS_NOT_FOUND: ${args.path} does not exist`, isError: true };
  }
  if (st.stat.kind !== "file") {
    return { content: `FS_NOT_REGULAR_FILE: ${args.path} is not a regular file; use grep to explore directories`, isError: true };
  }
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_LIMIT;
  const open = await env.openRead(path);
  if (!open.ok) {
    const content = openFailText(open.reason, args.path);
    return { content, isError: true };
  }
  const { handle, version } = open;
  try {
    return await scanOutcome({ handle, version, observed, env, ctx, args, path, offset, limit, byteBudget: input.byteBudget });
  } catch (error) {
    if (error instanceof ReadIoError) return { content: "FS_READ_FAILED: i/o error while reading", isError: true };
    throw error;
  } finally {
    await handle.close();
  }
}

/** 嗅探→扫描→登记→终态文案（fd 版本登记先于空文件/越界分支——空文件也是有效观察） */
async function scanOutcome(input: {
  readonly handle: ReadHandle;
  readonly version: { readonly ino: string; readonly size: string; readonly mtimeNs: string };
  readonly observed: ObservedRegistry;
  readonly env: ReadFace;
  readonly ctx: ToolExecContext;
  readonly args: { path: string };
  /** admit 后的词法绝对路径——观察登记键（write 侧 lookup 同键） */
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
  /** 预算上界（批量模式传剩余额度；缺省 = BYTE_BUDGET） */
  readonly byteBudget?: number;
}): Promise<{ content: string; isError?: true }> {
  const { handle, version, observed, env, ctx, args, path, offset, limit } = input;
  const byteBudget = input.byteBudget ?? BYTE_BUDGET;
  // 空文件时嗅探测不出 BOM——沿用本会话既往观察（write 侧 BOM round-trip 依据）
  const knownHadBom = observed.lookup(ctx.session, path)?.hadBom ?? false;
  const sniff = await sniffHead(handle);
  if (sniff.binary) return { content: `FS_BINARY_FILE: ${args.path} looks binary (NUL byte in first ${String(BINARY_SNIFF)} bytes)`, isError: true };
  const hadBom = sniff.hadBom || (!sniff.sawBytes && knownHadBom);
  const window = await scanWindow({ handle, pending: sniff.pending, offset, limit, hadBom, byteBudget });
  if (window === undefined) {
    return { content: `OFFSET_BEYOND_EOF: file has ${String(await countLines(env, path))} lines; offset ${String(offset)} is past the end`, isError: true };
  }
  observed.record(ctx.session, path, { ...version, hadBom }); // fd 版本（open 时刻）
  if (window.totalLines === 0) return { content: "(empty file)" };
  return { content: render(args.path, window) };
}

interface Sniff {
  readonly binary: boolean;
  readonly hadBom: boolean;
  readonly sawBytes: boolean;
  /** 嗅探已读走的字节——扫描窗口从待处理缓冲续读（单句柄顺序流，不重开） */
  readonly pending: Uint8Array[];
}

async function sniffHead(handle: ReadHandle): Promise<Sniff> {
  const pending: Uint8Array[] = [];
  let buffered = 0;
  let sawBytes = false;
  for (;;) {
    if (buffered >= BINARY_SNIFF) break;
    const data = await readChunk(handle);
    if (data === null) break;
    sawBytes = true;
    pending.push(data);
    buffered += data.byteLength;
  }
  const head = Buffer.concat(pending.map((p) => Buffer.from(p))).subarray(0, BINARY_SNIFF);
  return {
    binary: head.includes(0),
    hadBom: head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf,
    sawBytes,
    pending,
  };
}

/** 全文件行数（数到 EOF——total 页脚口径；独立句柄流式，无内存放大） */
async function countLines(env: ReadFace, path: string): Promise<number> {
  const open = await env.openRead(path);
  if (!open.ok) return 0;
  try {
    const window = await scanWindow({ handle: open.handle, pending: [], offset: 1, limit: 1, hadBom: false });
    return window?.totalLines ?? 0;
  } catch (error) {
    if (error instanceof ReadIoError) return 0;
    throw error;
  } finally {
    await open.handle.close();
  }
}

/**
 * 行窗口扫描（异步流式 + 手动行拆）。返回 undefined = offset 越过 EOF。
 * byteCapped = 渲染字节预算先到。pending 为嗅探已读走的缓冲，先于句柄续读消费。
 */
interface ScanInput {
  readonly handle: ReadHandle;
  readonly pending: readonly Uint8Array[];
  readonly offset: number;
  readonly limit: number;
  readonly hadBom: boolean;
  /** 渲染字节预算（批量模式传剩余额度；缺省 = BYTE_BUDGET） */
  readonly byteBudget?: number;
}

async function scanWindow(input: ScanInput): Promise<ReadWindow | undefined> {
  const { handle, pending, offset, limit, hadBom } = input;
  const budget = input.byteBudget ?? BYTE_BUDGET;
  const decoder = new StringDecoder("utf8"); // chunk 边界撕裂多字节防护
  let carry = "";
  let totalLines = 0;
  const rendered: string[] = [];
  let budgetLeft = budget;
  let byteCapped = false;
  let lastShown = 0;
  const drainCarry = (buffered: string): string => {
    let rest = buffered;
    let nl = rest.indexOf("\n");
    while (nl >= 0) {
      collect(stripCr(rest.slice(0, nl)));
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
    return rest;
  };

  const collect = (line: string): void => {
    totalLines += 1;
    if (totalLines >= offset && rendered.length < limit && !byteCapped) {
      const text = line.length > LINE_TRUNCATE ? `${line.slice(0, LINE_TRUNCATE)}… (line truncated to ${String(LINE_TRUNCATE)} chars)` : line;
      const prefix = `${String(totalLines)}: `;
      const cost = Buffer.byteLength(prefix + text) + 1;
      if (cost > budgetLeft) {
        byteCapped = true;
        return;
      }
      budgetLeft -= cost;
      rendered.push(prefix + text);
      lastShown = totalLines;
    }
  };
  let awaitingBom = hadBom; // 仅首块判定一次（prefer-const 友好的单变量）
  const feed = (data: Uint8Array): void => {
    let text = decoder.write(data);
    if (awaitingBom && text.startsWith("﻿")) {
      text = text.slice(1); // 首块剥 BOM（展示口径；write 侧补回）
    }
    awaitingBom = false;
    if (text.includes("\n")) {
      carry += text;
      carry = drainCarry(carry);
    } else if (carry.length < LINE_TRUNCATE) {
      carry += text; // 行内累计（截断上限内）——无换行 chunk 不触发全量重扫
    }
    // 行已超截断上限的后续 chunk 丢弃（渲染只保留前 LINE_TRUNCATE 字符）
  };
  for (const data of pending) {
    feed(data);
    if (byteCapped) break;
  }
  if (!byteCapped) {
    for (;;) {
      const data = await readChunk(handle);
      if (data === null) break;
      feed(data);
      if (byteCapped) break;
    }
  }
  carry += decoder.end();
  if (carry !== "" && !byteCapped) collect(stripCr(carry)); // 无尾换行的末行
  if (totalLines > 0 && offset > totalLines) return undefined; // 空文件（0 行）不是越界
  return { rendered, shownLines: rendered.length, totalLines, byteCapped, budgetBytes: budget, firstLine: offset, lastShown };
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function render(displayPath: string, w: ReadWindow): string {
  if (w.totalLines === 0) return `(empty file)`;
  const body = w.rendered.length > 0 ? w.rendered.join("\n") : `(no lines shown — offset ${String(w.firstLine)} is past the last line)`;
  const footers: string[] = [];
  if (w.byteCapped) {
    footers.push(`Output capped at ${String(w.budgetBytes)} bytes (rendered). Use offset=${String(w.lastShown + 1)} to read on`);
  } else if (w.lastShown < w.totalLines) {
    footers.push(`Showing lines ${String(w.firstLine)}-${String(w.lastShown)} of ${String(w.totalLines)}. Use offset=${String(w.lastShown + 1)} to read on`);
  }
  void displayPath;
  return footers.length === 0 ? body : `${body}\n${footers.join("\n")}`;
}

export { BOM as READ_BOM };
