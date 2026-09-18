// writeFileAtomic 契约实现（docs/EXEC-ENV.md §1/§2）：同目录 temp（wx 0600）+ rename 原子替换
// （落在 symlink 上替换链接本身——TOOLBOX §3 锁定语义）；存在文件承袭其 mode（D1 修复：mode 只保持
// 不放宽）；短写循环续写；失败清 temp 无残留；注错缝 failAt 分段失败（conformance local 腿用）。

import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WriteFileOptions, WriteFileResult } from "../types.ts";
import { statLocal } from "./stat.ts";

const DEFAULT_CREATE_MODE = 0o600;

type Deny = { readonly ok: false; readonly reason: "is_directory" | "not_directory_parent" | "access_denied" };
type Fail = { readonly ok: false; readonly reason: "write_failed"; readonly detail: string };
type Reject = Deny | Fail;

function denyOf(code: string | undefined): Deny | undefined {
  if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "access_denied" };
  if (code === "ENOTDIR") return { ok: false, reason: "not_directory_parent" };
  return undefined;
}

/** 目标预取：存在文件的承袭 mode（目录目标在此显式拒绝） */
function existingModeOf(p: string): { mode?: number; reject?: Deny } {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return { reject: { ok: false, reason: "is_directory" } };
    if (st.isFile()) return { mode: st.mode & 0o777 };
    return {};
  } catch (error) {
    const deny = denyOf((error as NodeJS.ErrnoException).code);
    return deny !== undefined ? { reject: deny } : {};
  }
}

/** 父目录就位：makeParents 递归建；否则必须已是目录（缺失/文件段 → not_directory_parent） */
function ensureParent(p: string, makeParents: boolean): Reject | undefined {
  if (makeParents) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      return undefined;
    } catch (error) {
      const deny = denyOf((error as NodeJS.ErrnoException).code);
      if (deny !== undefined) return deny;
      return { ok: false, reason: "write_failed", detail: (error as Error).message };
    }
  }
  const parent = statLocal(dirname(p));
  if (!parent.ok || parent.stat.kind !== "dir") return { ok: false, reason: "not_directory_parent" };
  return undefined;
}

interface TempWrite {
  readonly path: string;
  readonly temp: string;
  readonly content: Uint8Array;
  readonly existingMode: number | undefined;
  readonly failAt: WriteFileOptions["failAt"];
}

/** temp 写入 + 承袭 fchmod + rename；任何失败清 temp 后归一为 Reject */
function writeAndRename(req: TempWrite): Reject | undefined {
  const { path, temp, content, existingMode, failAt } = req;
  try {
    const fd = openSync(temp, "wx", DEFAULT_CREATE_MODE);
    try {
      writeAll(fd, Buffer.from(content), failAt);
      if (existingMode !== undefined) {
        fchmodSync(fd, existingMode); // D1：承袭存在文件 mode（只保持不放宽——0644 保持 0644）
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path); // POSIX 原子替换；落在 symlink 上替换链接本身
    return undefined;
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* 清理失败不再叠加 */
    }
    const deny = denyOf((error as NodeJS.ErrnoException).code);
    if (deny !== undefined) return deny;
    return { ok: false, reason: "write_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 部分写循环（ENOSPC 半截不晋升）；failAt 注错：先写到注入点，此后 eio=抛 / short_write=逐字节续写 */
function writeAll(fd: number, buf: Buffer, failAt: WriteFileOptions["failAt"]): void {
  let written = 0;
  while (written < buf.length) {
    if (failAt !== undefined) {
      if (written < failAt.afterBytes) {
        const upto = Math.min(failAt.afterBytes, buf.length);
        written += writeSync(fd, buf, written, upto - written); // 先行写到注入点
        continue;
      }
      if (failAt.error === "eio") throw new Error("EIO: injected i/o error (failAt)");
      writeSync(fd, buf, written, 1); // short_write：逐字节续写（验证循环不半截）
      written += 1;
      continue;
    }
    written += writeSync(fd, buf, written);
  }
}

export async function writeFileAtomicLocal(p: string, content: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult> {
  const existing = existingModeOf(p);
  if (existing.reject !== undefined) return existing.reject;
  const parentReject = ensureParent(p, opts.makeParents);
  if (parentReject !== undefined) return parentReject;
  const temp = join(dirname(p), `.${randomBytes(6).toString("hex")}.tmp`);
  const reject = writeAndRename({ path: p, temp, content, existingMode: existing.mode, failAt: opts.failAt });
  if (reject !== undefined) return reject;
  const after = statLocal(p);
  if (!after.ok) return { ok: false, reason: "write_failed", detail: "post-write stat failed" };
  return { ok: true, stat: after.stat };
}
