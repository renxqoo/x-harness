import type { FileHandle } from "node:fs/promises";
import type { RecordIndex } from "./types";
import type { StoragePolicy } from "../../session/src/storage";
import { digest, parseLine } from "./encode-line";
import { readRecord } from "./read-values";
import { stop } from "./fail";
export async function recordLine(handle: FileHandle, index: RecordIndex): Promise<Buffer> {
  const raw = Buffer.alloc(index.length); let count = 0;
  while (count < raw.length) { const read = await handle.read(raw, count, raw.length - count, index.offset + count); if (!read.bytesRead) stop("storage-corrupt"); count += read.bytesRead; }
  if (digest(raw) !== index.digest) stop("storage-corrupt"); return raw;
}
export async function storedRecord(handle: FileHandle, index: RecordIndex, options: { seq: number; policy: StoragePolicy }) { return readRecord(parseLine(await recordLine(handle, index)).record, options.seq, options.policy); }
