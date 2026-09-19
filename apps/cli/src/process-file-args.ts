// @file 引用展开（docs/CLI.md §2.1/§2.3 不处理项）：@path 参数 → <file name="…"> 文本块。
// 仅文本文件（含 NUL 视为二进制拒绝）；BOM 剥离；~ 展开；缺席/不可读 → 失败理由（exit 2）。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Result } from "@x-harness/core";

/** ~/<rest> → $HOME/<rest>；其余原样（pi 同款最小展开） */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return path;
}

export function wrapFileBlock(path: string, text: string): string {
  return `<file name="${path}">\n${text.replace(/^\uFEFF/, "")}\n</file>\n`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** 逐文件展开拼接；空文件跳过（无块）；缺席 → no such file；二进制 → 拒绝 */
export async function processFileArgs(paths: readonly string[], read: typeof readFile = readFile): Promise<Result<{ readonly text: string }>> {
  let text = "";
  for (const raw of paths) {
    const path = expandHome(raw);
    let content: string;
    try {
      content = await read(isAbsolute(path) ? path : resolve(path), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { ok: false, reason: `no such file: ${raw}` };
      return { ok: false, reason: `cannot read ${raw}: ${error instanceof Error ? error.message : "io error"}` };
    }
    if (content.includes("\u0000")) return { ok: false, reason: `${raw}: binary files are not supported` };
    if (content.trim().length === 0) continue;
    text += wrapFileBlock(raw, content);
  }
  return { ok: true, value: { text } };
}
