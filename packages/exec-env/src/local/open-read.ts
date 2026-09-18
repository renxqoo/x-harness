// openRead 契约实现（docs/EXEC-ENV.md §1）：version 取自打开 fd 的 fstat（stat/open 竞态根治原语——
// D2）；目录/非普通文件经 fd 判 not_regular。O_NONBLOCK 打开：无写者 FIFO 的 O_RDONLY 会同步阻塞
// 事件循环——非阻塞打开后 fstat 判型即拒（对常规文件读无影响，POSIX 语义）。read 不 throw，
// I/O 错误走 io_error 通道。

import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import type { OpenReadResult, ReadChunk, ReadHandle } from "../types.ts";

const CHUNK = 1 << 16;

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* close 副作用不再叠加 */
  }
}

/** 注错缝：ioErrorAt 字节后首读起 io_error（conformance local 腿用；生产不传） */
export class LocalReadHandle implements ReadHandle {
  private closed = false;
  private served = 0;
  private readonly fault: number | undefined;

  constructor(
    private readonly fd: number,
    opts: { readonly ioErrorAt?: number } = {},
  ) {
    this.fault = opts.ioErrorAt;
  }

  async read(): Promise<ReadChunk> {
    if (this.closed) return { ok: true, data: null };
    if (this.fault !== undefined && this.served >= this.fault) return { ok: false, reason: "io_error" };
    const buffer = Buffer.alloc(CHUNK);
    try {
      const n = readSync(this.fd, buffer, 0, CHUNK, null);
      if (n === 0) return { ok: true, data: null };
      this.served += n;
      return { ok: true, data: buffer.subarray(0, n) };
    } catch {
      return { ok: false, reason: "io_error" };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    closeQuiet(this.fd);
  }
}

export function openReadLocal(p: string, seam: { readonly ioErrorAt?: number } = {}): OpenReadResult {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK); // FIFO 不阻塞——fstat 判型即拒
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "access_denied" };
    return { ok: false, reason: "not_found" };
  }
  let st: unknown;
  try {
    st = fstatSync(fd, { bigint: true });
  } catch {
    closeQuiet(fd);
    return { ok: false, reason: "not_found" };
  }
  const big = st as { ino: bigint; size: bigint; mtimeNs: bigint; isFile(): boolean };
  if (!big.isFile()) {
    closeQuiet(fd);
    return { ok: false, reason: "not_regular" };
  }
  return {
    ok: true,
    handle: new LocalReadHandle(fd, seam),
    version: { ino: big.ino.toString(), size: big.size.toString(), mtimeNs: big.mtimeNs.toString() },
  };
}
