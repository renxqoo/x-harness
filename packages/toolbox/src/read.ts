// read 工具（docs/TOOLBOX.md §2）：逐行流式（绝不整读）；2000 行/50KB 渲染字节双限；
// 行号连续；行动型页脚；二进制首 8KB 嗅探；!isFile 全拒；观察版本登记。

import { openSync, readSync, closeSync, statSync, type Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolExecContext } from "@x-harness/tools";
import type { PathGate } from "./paths.ts";
import { ObservedRegistry } from "./observed.ts";
import type { FileVersion } from "./observed.ts";

const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 2_000;
const BYTE_BUDGET = 50_000;
const BINARY_SNIFF = 8_192;
const LINE_TRUNCATE = 2_000;
const BOM = "﻿";

interface ReadWindow {
  readonly rendered: string[];
  readonly shownLines: number;
  readonly totalLines: number;
  readonly byteCapped: boolean;
  readonly firstLine: number;
  readonly lastShown: number;
}

export function createReadTool(gate: PathGate, observed: ObservedRegistry): ToolDefinition {
  return {
    name: "read",
    description:
      "Read a text file within the workspace root. Returns numbered lines (offset/limit window, default and max 2000 lines, 50KB byte budget). Long lines are truncated. Use the footer's offset hint to continue reading.",
    inputSchema: Type.Object({
      path: Type.String({ description: "File path (relative to workspace root or absolute inside it)" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to start from" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Max lines (default and cap ${String(DEFAULT_LIMIT)})` })),
    }),
    isConcurrencySafe: () => true,
    execute: async (args, ctx: ToolExecContext) => readFile({ gate, observed, ctx, args: args as { path: string; offset?: number; limit?: number } }),
  };
}

async function readFile(input: { readonly gate: PathGate; readonly observed: ObservedRegistry; readonly ctx: ToolExecContext; readonly args: { path: string; offset?: number; limit?: number } }): Promise<{ content: string; isError?: true }> {
  const { gate, observed, ctx, args } = input;
  const admitted = gate.admit(args.path);
  if (!admitted.ok) return { content: admitted.reason, isError: true };
  const path = admitted.path;
  let st: Stats;
  try {
    st = statSync(path);
  } catch (error) {
    if (accessDenied(error)) return { content: `FS_ACCESS_DENIED: ${args.path}: ${(error as Error).message}`, isError: true };
    return { content: `FS_NOT_FOUND: ${args.path} does not exist`, isError: true };
  }
  if (!st.isFile()) {
    return { content: `FS_NOT_REGULAR_FILE: ${args.path} is not a regular file; use grep to explore directories`, isError: true };
  }
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_LIMIT;
  let sniff: Sniff;
  try {
    sniff = sniffHead(path);
  } catch (error) {
    if (accessDenied(error)) return { content: `FS_ACCESS_DENIED: ${args.path}: ${(error as Error).message}`, isError: true };
    return { content: `FS_NOT_FOUND: ${args.path} does not exist`, isError: true };
  }
  if (sniff.binary) return { content: `FS_BINARY_FILE: ${args.path} looks binary (NUL byte in first ${String(BINARY_SNIFF)} bytes)`, isError: true };
  const window = scanWindow({ path, offset, limit, hadBom: sniff.hadBom });
  if (window !== undefined) observed.record(ctx.session, path, sniff.version); // peek 前版本元组 + peek 实测 hadBom（fail-closed；空文件也是有效观察）
  if (window !== undefined && window.totalLines === 0) return { content: "(empty file)" };
  if (window === undefined) {
    return { content: `OFFSET_BEYOND_EOF: file has ${String(countLines(path))} lines; offset ${String(offset)} is past the end`, isError: true };
  }
  return { content: render(args.path, window) };
}

interface Sniff {
  readonly binary: boolean;
  readonly hadBom: boolean;
  /** peek 前 stat 的版本元组——hadBom 用 peek 实测值回填（write 补回依据） */
  readonly version: FileVersion;
}

function sniffHead(path: string): Sniff {
  const fd = openSync(path, "r");
  try {
    const tuple = ObservedRegistry.tupleOf(path);
    const head = Buffer.alloc(BINARY_SNIFF);
    const read = readSync(fd, head, 0, BINARY_SNIFF, 0);
    const slice = head.subarray(0, read);
    const hadBom = slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf;
    return { binary: slice.includes(0), hadBom, version: { ...tuple, hadBom } };
  } finally {
    closeSync(fd);
  }
}

/** 全文件行数（数到 EOF——total 页脚口径；流式无内存放大） */
function countLines(path: string): number {
  return scanWindow({ path, offset: 1, limit: 1, hadBom: false })?.totalLines ?? 0;
}

/**
 * 行窗口扫描（同步逐块 + 手动行拆——Bun 下比 readline 闭包更可控且避免双开流）。
 * 返回 undefined = offset 越过 EOF。byteCapped = 渲染字节预算先到。
 */
interface ScanInput {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
  readonly hadBom: boolean;
}

function scanWindow(input: ScanInput): ReadWindow | undefined {
  const { path, offset, limit, hadBom } = input;
  const fd = openSync(path, "r");
  try {
    const chunkSize = 1 << 16;
    const buffer = Buffer.alloc(chunkSize);
    let carry = "";
    let totalLines = 0;
    let bytesSeen = 0;
    const rendered: string[] = [];
    let budget = BYTE_BUDGET;
    let byteCapped = false;
    let lastShown = 0;
    const drainCarry = (buffered: string): string => {
      let rest = buffered;
      let nl = rest.indexOf("\n");
      while (nl >= 0) {
        collect(stripCr(rest.slice(0, nl)), true);
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
      }
      return rest;
    };

    const collect = (line: string, hasNewline: boolean): void => {
      totalLines += 1;
      if (totalLines >= offset && rendered.length < limit && !byteCapped) {
        const text = line.length > LINE_TRUNCATE ? `${line.slice(0, LINE_TRUNCATE)}… (line truncated to ${String(LINE_TRUNCATE)} chars)` : line;
        const prefix = `${String(totalLines)}: `;
        const cost = Buffer.byteLength(prefix + text) + 1;
        if (cost > budget) {
          byteCapped = true;
          return;
        }
        budget -= cost;
        rendered.push(prefix + text);
        lastShown = totalLines;
      }
      void hasNewline;
    };
    let skipBom = hadBom;
    const decoder = new StringDecoder("utf8"); // chunk 边界撕裂多字节防护
    for (;;) {
      const read = readSync(fd, buffer, 0, chunkSize, bytesSeen);
      if (read === 0) break;
      bytesSeen += read;
      let text = decoder.write(buffer.subarray(0, read));
      if (skipBom && bytesSeen === read && text.startsWith("\ufeff")) {
        text = text.slice(1); // 首块剥 BOM（展示口径；write 侧补回）
      }
      skipBom = false;
      if (text.includes("\n")) {
        carry += text;
        carry = drainCarry(carry);
      } else if (carry.length < LINE_TRUNCATE) {
        carry += text; // 行内累计（截断上限内）——无换行 chunk 不触发全量重扫
      }
      // 行已超截断上限的后续 chunk 丢弃（渲染只保留前 LINE_TRUNCATE 字符）
      if (byteCapped) break;
    }
    carry += decoder.end();
    if (carry !== "" && !byteCapped) collect(stripCr(carry), false); // 无尾换行的末行
    if (totalLines > 0 && offset > totalLines) return undefined; // 空文件（0 行）不是越界
    return { rendered, shownLines: rendered.length, totalLines, byteCapped, firstLine: offset, lastShown };
  } finally {
    closeSync(fd);
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 权限类 errno 判定（EACCES/EPERM——与「不存在」分开报，行动指引不同） */
function accessDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function render(displayPath: string, w: ReadWindow): string {
  if (w.totalLines === 0) return `(empty file)`;
  const body = w.rendered.length > 0 ? w.rendered.join("\n") : `(no lines shown — offset ${String(w.firstLine)} is past the last line)`;
  const footers: string[] = [];
  if (w.byteCapped) {
    footers.push(`Output capped at ${String(BYTE_BUDGET)} bytes (rendered). Use offset=${String(w.lastShown + 1)} to read on`);
  } else if (w.lastShown < w.totalLines) {
    footers.push(`Showing lines ${String(w.firstLine)}-${String(w.lastShown)} of ${String(w.totalLines)}. Use offset=${String(w.lastShown + 1)} to read on`);
  }
  void displayPath;
  return footers.length === 0 ? body : `${body}\n${footers.join("\n")}`;
}

export { BOM as READ_BOM };
