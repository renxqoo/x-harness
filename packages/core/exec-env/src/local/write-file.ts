import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WriteFileOptions, WriteFileResult } from "../types.ts";
import { statLocal } from "./stat.ts";

const DEFAULT_CREATE_MODE = 0o600;
const TEMP_ATTEMPTS = 3;

type Deny = { readonly ok: false; readonly reason: "is_directory" | "not_regular" | "not_directory_parent" | "access_denied" };
type Fail = { readonly ok: false; readonly reason: "write_failed"; readonly detail: string };
type Reject = Deny | Fail;

function denyOf(code: string | undefined): Deny | undefined {
  if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "access_denied" };
  if (code === "ENOTDIR" || code === "EEXIST") return { ok: false, reason: "not_directory_parent" };
  return undefined;
}

function existingModeOf(p: string): { mode?: number; reject?: Deny } {
  try {
    const st = statSync(p);
    if (st.isDirectory()) return { reject: { ok: false, reason: "is_directory" } };
    if (st.isFile()) return { mode: st.mode & 0o777 };
    return { reject: { ok: false, reason: "not_regular" } };
  } catch (error) {
    const deny = denyOf((error as NodeJS.ErrnoException).code);
    return deny !== undefined ? { reject: deny } : {};
  }
}

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

function writeAll(fd: number, buf: Buffer, failAt: WriteFileOptions["failAt"]): void {
  let written = 0;
  while (written < buf.length) {
    if (failAt !== undefined) {
      if (written < failAt.afterBytes) {
        const upto = Math.min(failAt.afterBytes, buf.length);
        written += writeSync(fd, buf, written, upto - written);
        continue;
      }
      if (failAt.error === "eio") throw new Error("EIO: injected i/o error (failAt)");
      writeSync(fd, buf, written, 1);
      written += 1;
      continue;
    }
    written += writeSync(fd, buf, written);
  }
}

interface TempWrite {
  readonly path: string;
  readonly dir: string;
  readonly content: Uint8Array;
  readonly existingMode: number | undefined;
  readonly failAt: WriteFileOptions["failAt"];
}

function writeAndRename(req: TempWrite): Reject | undefined {
  const { path, dir, content, existingMode, failAt } = req;
  let lastCollision = "";
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt++) {
    const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
    let owned = false;
    try {
      const fd = openSync(temp, "wx", DEFAULT_CREATE_MODE);
      owned = true;
      try {
        writeAll(fd, Buffer.from(content), failAt);
        if (existingMode !== undefined) {
          fchmodSync(fd, existingMode);
        }
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      return undefined;
    } catch (error) {
      if (owned) {
        try {
          unlinkSync(temp);
        } catch {
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && !owned) {
        lastCollision = temp;
        continue;
      }
      const deny = denyOf(code);
      if (deny !== undefined) return deny;
      return { ok: false, reason: "write_failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, reason: "write_failed", detail: `temp name collision (EEXIST x${String(TEMP_ATTEMPTS)}): ${lastCollision}` };
}

export async function writeFileAtomicLocal(p: string, content: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult> {
  const existing = existingModeOf(p);
  if (existing.reject !== undefined) return existing.reject;
  const parentReject = ensureParent(p, opts.makeParents);
  if (parentReject !== undefined) return parentReject;
  const reject = writeAndRename({ path: p, dir: dirname(p), content, existingMode: existing.mode, failAt: opts.failAt });
  if (reject !== undefined) return reject;
  const after = statLocal(p);
  if (!after.ok) return { ok: false, reason: "write_failed", detail: "post-write stat failed" };
  return { ok: true, stat: after.stat };
}
