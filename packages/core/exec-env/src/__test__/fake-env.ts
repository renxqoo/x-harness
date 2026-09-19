// 内存 fake env（conformance 假腿）：从真目录一次性水化进 Map，此后一切操作不碰 node:fs。
// read 面（小块 chunk 故意撕裂多字节边界）+ write 面（覆写换 ino——rename 语义模拟）+ readDir 面。
// spawn 面不实现——内核级语义（组杀/settle）local 腿权威。用途=契约隔离 + 远端 env 预演。

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { OpenReadResult, ReadChunk, ReadDirResult, ReadFace, ReadHandle, WriteFileOptions, WriteFileResult, WriteFace, ReadDirFace } from "../types.ts";
import type { FileStat } from "../types.ts";

interface FakeEntry {
  kind: "file" | "dir";
  data: Buffer | undefined;
  ino: string;
}

export interface FakeEnvOptions {
  /** 每次 read() 的切片大小（缺省 7——激进撕裂 chunk 边界） */
  readonly chunkSize?: number;
  /** 首读即 io_error（粘性）的文件绝对路径列表 */
  readonly failReadsOf?: readonly string[];
}

class FakeHandle implements ReadHandle {
  private offset = 0;
  private closed = false;

  constructor(
    private readonly data: Buffer,
    private readonly chunkSize: number,
    private readonly fail: boolean,
  ) {}

  async read(): Promise<ReadChunk> {
    if (this.closed) return { ok: true, data: null };
    if (this.fail) return { ok: false, reason: "io_error" };
    if (this.offset >= this.data.byteLength) return { ok: true, data: null };
    const slice = this.data.subarray(this.offset, this.offset + this.chunkSize);
    this.offset += slice.byteLength;
    return { ok: true, data: new Uint8Array(slice) };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeEnv extends ReadFace, WriteFace, ReadDirFace {}

export function createFakeEnv(root: string, opts: FakeEnvOptions = {}): FakeEnv {
  const entries = new Map<string, FakeEntry>();
  let seq = 0;
  entries.set(resolve(root), { kind: "dir", data: undefined, ino: String(++seq) }); // root 自身入册
  const hydrate = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(join(dir, ent.name));
      if (ent.isDirectory()) {
        entries.set(p, { kind: "dir", data: undefined, ino: String(++seq) });
        hydrate(p);
      } else if (ent.isFile()) {
        entries.set(p, { kind: "file", data: readFileSync(p), ino: String(++seq) });
      }
      // symlink 不水化——fake 腿不覆盖内核级符号链接语义（local 腿权威）
    }
  };
  hydrate(root);

  const entryAt = (p: string): FakeEntry | undefined => entries.get(resolve(p));
  const statOf = (entry: FakeEntry): FileStat => {
    const size = entry.data?.byteLength ?? 0;
    return { kind: entry.kind, size, version: { ino: entry.ino, size: String(size), mtimeNs: "0" } };
  };

  return {
    kind: "fake",
    root: resolve(root),
    realpath: async (p) => resolve(resolve(root), p), // 相对入参锚 root（与 local 同口径）
    stat: async (p) => {
      const entry = entryAt(p);
      if (entry === undefined) return { ok: false, reason: "not_found" };
      return { ok: true, stat: statOf(entry) };
    },
    openRead: async (p): Promise<OpenReadResult> => {
      const entry = entryAt(p);
      if (entry === undefined) return { ok: false, reason: "not_found" };
      if (entry.kind !== "file" || entry.data === undefined) return { ok: false, reason: "not_regular" };
      const fail = opts.failReadsOf?.includes(resolve(p)) ?? false;
      return { ok: true, handle: new FakeHandle(entry.data, opts.chunkSize ?? 7, fail), version: statOf(entry).version };
    },
    writeFileAtomic: async (p, content: Uint8Array, wopts: WriteFileOptions): Promise<WriteFileResult> => {
      const target = resolve(p);
      const existing = entryAt(target);
      if (existing !== undefined && existing.kind === "dir") return { ok: false, reason: "is_directory" };
      let parent = entryAt(dirname(target));
      if (parent === undefined || parent.kind !== "dir") {
        if (!wopts.makeParents) return { ok: false, reason: "not_directory_parent" };
        // makeParents：自根而下逐段补目录；中途撞上文件段 → not_directory_parent
        const segments = dirname(target).split("/").filter((seg, i) => !(i === 0 && seg === ""));
        let built = "";
        for (const seg of segments) {
          built = built === "" ? `/${seg}` : `${built}/${seg}`;
          const at = entries.get(built);
          if (at === undefined) entries.set(built, { kind: "dir", data: undefined, ino: String(++seq) });
          else if (at.kind !== "dir") return { ok: false, reason: "not_directory_parent" };
        }
        parent = entryAt(dirname(target));
      }
      if (parent === undefined || parent.kind !== "dir") return { ok: false, reason: "not_directory_parent" };
      // rename 语义模拟：覆写换 ino（temp+rename 每次换 inode 的契约面）
      entries.set(target, { kind: "file", data: Buffer.from(content), ino: String(++seq) });
      const fresh = entryAt(target);
      if (fresh === undefined) return { ok: false, reason: "write_failed", detail: "fake post-write miss" };
      return { ok: true, stat: statOf(fresh) };
    },
    readDir: async (p): Promise<ReadDirResult> => {
      const dir = entryAt(p);
      if (dir === undefined) return { ok: false, reason: "not_found" };
      if (dir.kind !== "dir") return { ok: false, reason: "not_directory" };
      const prefix = `${resolve(p)}/`;
      const names: string[] = [];
      for (const key of entries.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.push(key.slice(prefix.length));
      }
      // fake 不水化 symlink——目录项 kind 只出 file/dir（内核级 symlink 语义 local 腿权威）
      return {
        ok: true,
        entries: names.sort().map((name) => ({ name, kind: (entries.get(`${prefix}${name}`)?.kind ?? "other") as "file" | "dir" | "other" })),
      };
    },
  };
}
