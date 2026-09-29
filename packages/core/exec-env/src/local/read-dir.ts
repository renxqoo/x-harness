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
