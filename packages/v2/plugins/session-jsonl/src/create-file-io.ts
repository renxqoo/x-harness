import { open, mkdir, lstat, readdir, rename, unlink, realpath } from "node:fs/promises";

export function createFileIO() {
  return { open, mkdir, lstat, readdir, rename, unlink, realpath };
}
