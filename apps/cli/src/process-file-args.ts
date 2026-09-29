import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Result } from "@x-harness/core";

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
