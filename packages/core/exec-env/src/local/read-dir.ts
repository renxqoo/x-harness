// readDir 契约实现（docs/EXEC-ENV.md §1）：目录项带 kind（symlink 不跟——walker 跳过依据）；
// ENOENT/ENOTDIR/EACCES 显式判别，其余降级 not_found（垃圾输入空形态）。

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { DirEntry, ReadDirResult } from "../types.ts";

function kindOf(ent: Dirent): DirEntry["kind"] {
  if (ent.isFile()) return "file";
  if (ent.isDirectory()) return "dir";
  if (ent.isSymbolicLink()) return "symlink";
  return "other";
}

export async function readDirLocal(p: string): Promise<ReadDirResult> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(p, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "access_denied" };
    if (code === "ENOTDIR") return { ok: false, reason: "not_directory" };
    return { ok: false, reason: "not_found" };
  }
  const entries: DirEntry[] = dirents.map((ent) => ({ name: ent.name, kind: kindOf(ent) }));
  return { ok: true, entries };
}
