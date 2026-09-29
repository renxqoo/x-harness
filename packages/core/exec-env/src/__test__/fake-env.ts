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
  readonly chunkSize?: number;
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
  entries.set(resolve(root), { kind: "dir", data: undefined, ino: String(++seq) });
  const hydrate = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(join(dir, ent.name));
      if (ent.isDirectory()) {
        entries.set(p, { kind: "dir", data: undefined, ino: String(++seq) });
        hydrate(p);
      } else if (ent.isFile()) {
        entries.set(p, { kind: "file", data: readFileSync(p), ino: String(++seq) });
      }
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
    realpath: async (p) => resolve(resolve(root), p),
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
      return {
        ok: true,
        entries: names.sort().map((name) => ({ name, kind: (entries.get(`${prefix}${name}`)?.kind ?? "other") as "file" | "dir" | "other" })),
      };
    },
  };
}
