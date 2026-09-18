// 内存 fake read 面（conformance 假腿）：从真目录一次性水化进 Map，此后一切操作不碰 node:fs。
// 用途=契约隔离 + 远端 env 预演（小块 chunk 故意撕裂多字节边界）；内核级语义以 local 腿为权威。

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OpenReadResult, ReadChunk, ReadFace, ReadHandle } from "../types.ts";

interface FakeEntry {
  readonly kind: "file" | "dir";
  readonly data: Buffer | undefined;
  readonly ino: string;
}

export interface FakeReadOptions {
  /** 每次 read() 的切片大小（缺省 7——激进撕裂 chunk 边界） */
  readonly chunkSize?: number;
  /** 首读即 io_error（粘性）的文件绝对路径列表 */
  readonly failReadsOf?: readonly string[];
}

class FakeHandle implements ReadHandle {
  private offset = 0;
  private failed = false;
  private closed = false;

  constructor(
    private readonly data: Buffer,
    private readonly chunkSize: number,
    private readonly fail: boolean,
  ) {}

  async read(): Promise<ReadChunk> {
    if (this.closed) return { ok: true, data: null };
    if (this.fail) {
      this.failed = true;
      return { ok: false, reason: "io_error" };
    }
    void this.failed;
    if (this.offset >= this.data.byteLength) return { ok: true, data: null };
    const slice = this.data.subarray(this.offset, this.offset + this.chunkSize);
    this.offset += slice.byteLength;
    return { ok: true, data: new Uint8Array(slice) };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function createFakeReadFace(root: string, opts: FakeReadOptions = {}): ReadFace {
  const entries = new Map<string, FakeEntry>();
  let seq = 0;
  const hydrate = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        entries.set(resolve(p), { kind: "dir", data: undefined, ino: String(++seq) });
        hydrate(p);
      } else if (ent.isFile()) {
        entries.set(resolve(p), { kind: "file", data: readFileSync(p), ino: String(++seq) });
      }
      // symlink 不水化——fake 腿不覆盖内核级符号链接语义（local 腿权威）
    }
  };
  hydrate(root);

  const entryAt = (p: string): FakeEntry | undefined => entries.get(resolve(p));

  return {
    kind: "fake",
    root: resolve(root),
    realpath: async (p) => resolve(p),
    stat: async (p) => {
      const entry = entryAt(p);
      if (entry === undefined) return { ok: false, reason: "not_found" };
      const size = entry.data?.byteLength ?? 0;
      return { ok: true, stat: { kind: entry.kind, size, version: { ino: entry.ino, size: String(size), mtimeNs: "0" } } };
    },
    openRead: async (p): Promise<OpenReadResult> => {
      const entry = entryAt(p);
      if (entry === undefined) return { ok: false, reason: "not_found" };
      if (entry.kind !== "file" || entry.data === undefined) return { ok: false, reason: "not_regular" };
      const size = entry.data.byteLength;
      const version = { ino: entry.ino, size: String(size), mtimeNs: "0" };
      const fail = opts.failReadsOf?.includes(resolve(p)) ?? false;
      return { ok: true, handle: new FakeHandle(entry.data, opts.chunkSize ?? 7, fail), version };
    },
  };
}
