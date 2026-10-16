import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { FileIO } from "./types";
import { stop } from "./fail";
export function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
export async function openFile(io: FileIO, path: string, create = false): Promise<FileHandle> {
  const handle = await io.open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) stop("storage-corrupt"); return handle; } catch (error) { await handle.close(); throw error; }
}
export async function directory(io: FileIO, path: string, create = false): Promise<void> {
  if (create) { try { await io.mkdir(path, { mode: 0o700 }); } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; } }
  const stat = await io.lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) stop("storage-corrupt");
}
