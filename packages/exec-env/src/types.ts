// ExecEnv 契约（docs/EXEC-ENV.md §1）：fs 与 proc 对等双面、全判别联合不 throw、
// reason 闭集判别（错误 TEXT 契约存活的前提）；pid 不进契约（组杀/settle 语义经 kill/settled 抽象）。

import type { SessionId } from "@x-harness/session";

/** 版本元组：同 env 内可判等即可；全 string——wire/审计序列化安全 */
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

/** data null = EOF；io_error 绝不折成 EOF（假空比错误危险——TOOLBOX §9 纪律） */
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
  /** 信号死亡 = code null + signal；128+n 折算属渲染层 */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** 信号投递即 resolve；幂等、已死后调用为 no-op、永不 throw */
  kill(phase: "term" | "kill"): Promise<void>;
  /** 整树（含孙进程与 pidns 内进程）死净后 resolve——「组长退出≠组清空」的观测面 */
  readonly settled: Promise<void>;
}

export interface SpawnRequest {
  /** 逻辑 argv（如 ["/bin/sh","-c",cmd]）；实现自行包裹传输层 */
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** 围栏解析键；所有 spawn 调用点（含 rg）必须透传 ctx.session */
  readonly session?: SessionId;
}

export type SpawnFailure =
  | { readonly kind: "not_found"; readonly detail: string }
  | { readonly kind: "not_executable"; readonly detail: string }
  | { readonly kind: "cwd_invalid"; readonly detail: string }
  | { readonly kind: "sandbox_unavailable"; readonly detail: string }
  | { readonly kind: "io_error"; readonly detail: string };

/** spawn 失败即无句柄（无 exited）——spawnError 通道等价保留 */
export type SpawnResult = { readonly ok: true; readonly proc: ProcHandle } | { readonly ok: false; readonly reason: SpawnFailure };

/** EACCES 不折叠成 not_found——FS_ACCESS_DENIED 语义依赖此分支 */
export type StatResult = { readonly ok: true; readonly stat: FileStat } | { readonly ok: false; readonly reason: "not_found" | "access_denied" };

/** version 取自打开的 fd（fstat 原子）——stat/open 竞态（EXEC-ENV §3 D2）的根治原语 */
export type OpenReadResult =
  | { readonly ok: true; readonly handle: ReadHandle; readonly version: FileVersion }
  | { readonly ok: false; readonly reason: "not_found" | "not_regular" | "access_denied" };

/** write_failed 带 detail（模型可行动的错误面——ENOSPC/EIO 等原样透出）；
 *  not_directory_parent = 父路径不可用（缺失且未请求 makeParents，或某段是已存在的非目录） */
export type WriteFileResult =
  | { readonly ok: true; readonly stat: FileStat }
  | { readonly ok: false; readonly reason: "is_directory" | "not_directory_parent" | "access_denied" } // 简单拒绝无细节
  | { readonly ok: false; readonly reason: "write_failed"; readonly detail: string };

export type ReadDirResult =
  | { readonly ok: true; readonly entries: readonly DirEntry[] }
  | { readonly ok: false; readonly reason: "not_found" | "not_directory" | "access_denied" };

export interface WriteFileOptions {
  readonly makeParents: boolean;
  /** 注错缝：分段失败注入（conformance local 腿用；生产不传） */
  readonly failAt?: { readonly afterBytes: number; readonly error: "eio" | "short_write" };
}

export interface ExecEnv {
  readonly kind: string;
  /** env 内工作区根（realpath 归一） */
  readonly root: string;
  /**
   * 不存在路径 = 对最深存在祖先 realpath 后拼接余段（为「写新建文件」的门判定服务）。
   * 本语义是契约的一部分，conformance 锁定。
   */
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatResult>;
  openRead(p: string): Promise<OpenReadResult>;
  /** 同目录 temp + rename 原子写；存在文件承袭其 mode 且只收不放宽；新建缺省 0600 */
  writeFileAtomic(p: string, content: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult>;
  readDir(p: string): Promise<ReadDirResult>;
  spawn(req: SpawnRequest): Promise<SpawnResult>;
}

/** B0 切片面：toolbox read 改造所需的最小结构面（B1 起全量 ExecEnv） */
export type ReadFace = Pick<ExecEnv, "kind" | "root" | "realpath" | "stat" | "openRead">;
export type WriteFace = Pick<ExecEnv, "writeFileAtomic" | "stat">;
export type ReadDirFace = Pick<ExecEnv, "readDir" | "stat">;
