import type { FileHandle } from "node:fs/promises";
import { stop } from "./fail";
export async function* readLines(handle: FileHandle, options: { start: number; size: number; maximum: number; check(this: void): void }): AsyncGenerator<{ raw: Buffer; offset: number }> {
  const { start, size, maximum, check } = options;
  let offset = start; let chunks: Buffer[] = []; let pending = 0; let lineStart = start;
  while (offset < size) {
    check(); const buffer = Buffer.alloc(Math.min(65536, size - offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) stop("storage-corrupt"); offset += bytesRead;
    let cursor = 0; let newline: number;
    while ((newline = buffer.indexOf(10, cursor)) >= 0 && newline < bytesRead) {
      const length = pending + newline - cursor + 1; if (length > maximum) stop("storage-corrupt");
      const raw = pending ? Buffer.concat([...chunks, buffer.subarray(cursor, newline + 1)], length) : Buffer.from(buffer.subarray(cursor, newline + 1)); chunks = []; pending = 0; cursor = newline + 1;
      yield { raw, offset: lineStart }; lineStart += raw.length;
    }
    if (cursor < bytesRead) { if (pending + bytesRead - cursor > maximum) stop("storage-corrupt"); chunks.push(buffer.subarray(cursor, bytesRead)); pending += bytesRead - cursor; }
  }
}
