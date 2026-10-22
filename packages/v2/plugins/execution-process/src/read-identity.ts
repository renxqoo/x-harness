import { realpath, stat } from "node:fs/promises";
import type { FileIdentity } from "./types";

export async function readIdentity(path: string): Promise<FileIdentity> {
  const canonical = await realpath(path);
  const value = await stat(canonical);
  return Object.freeze({
    path: canonical,
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  });
}
