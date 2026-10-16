import type { FileHandle } from "node:fs/promises";
import { stop } from "./fail";
export async function writeLine(handle: FileHandle, raw: string | Buffer, offset: number): Promise<number> {
  const buffer = typeof raw === "string" ? Buffer.from(raw) : raw; let written = 0;
  while (written < buffer.length) { const result = await handle.write(buffer, written, buffer.length - written, offset + written); if (result.bytesWritten <= 0) stop("storage-unavailable"); written += result.bytesWritten; }
  return buffer.length;
}
