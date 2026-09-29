import type { SessionId } from "@x-harness/session";

export interface FileVersion {
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}

export interface FileStat {
  readonly kind: "file" | "dir" | "other";
  readonly size: number;
  readonly version: FileVersion;
}

export type ReadChunk = { readonly ok: true; readonly data: Uint8Array | null } | { readonly ok: false; readonly reason: "io_error" };

export interface ReadHandle {
  read(): Promise<ReadChunk>;
  close(): Promise<void>;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
}

export interface ProcHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  kill(phase: "term" | "kill"): Promise<void>;
  readonly settled: Promise<void>;
}

export interface SpawnRequest {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly session?: SessionId;
  readonly exec?: "direct" | "contained";
}

export type SpawnFailure =
  | { readonly kind: "not_found"; readonly detail: string }
  | { readonly kind: "not_executable"; readonly detail: string }
  | { readonly kind: "cwd_invalid"; readonly detail: string }
  | { readonly kind: "sandbox_unavailable"; readonly detail: string }
  | { readonly kind: "io_error"; readonly detail: string };

export type SpawnResult = { readonly ok: true; readonly proc: ProcHandle } | { readonly ok: false; readonly reason: SpawnFailure };

export type StatResult = { readonly ok: true; readonly stat: FileStat } | { readonly ok: false; readonly reason: "not_found" | "access_denied" };

export type OpenReadResult =
  | { readonly ok: true; readonly handle: ReadHandle; readonly version: FileVersion }
  | { readonly ok: false; readonly reason: "not_found" | "not_regular" | "access_denied" };

export type WriteFileResult =
  | { readonly ok: true; readonly stat: FileStat }
  | { readonly ok: false; readonly reason: "is_directory" | "not_regular" | "not_directory_parent" | "access_denied" }
  | { readonly ok: false; readonly reason: "write_failed"; readonly detail: string };

export type ReadDirResult =
  | { readonly ok: true; readonly entries: readonly DirEntry[] }
  | { readonly ok: false; readonly reason: "not_found" | "not_directory" | "access_denied" };

export interface WriteFileOptions {
  readonly makeParents: boolean;
  readonly failAt?: { readonly afterBytes: number; readonly error: "eio" | "short_write" };
}

export interface ExecEnv {
  readonly kind: string;
  readonly root: string;
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatResult>;
  openRead(p: string): Promise<OpenReadResult>;
  writeFileAtomic(p: string, content: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult>;
  readDir(p: string): Promise<ReadDirResult>;
  spawn(req: SpawnRequest): Promise<SpawnResult>;
}

export type ReadFace = Pick<ExecEnv, "kind" | "root" | "realpath" | "stat" | "openRead">;
export type WriteFace = Pick<ExecEnv, "writeFileAtomic" | "stat">;
export type ReadDirFace = Pick<ExecEnv, "readDir" | "stat">;
