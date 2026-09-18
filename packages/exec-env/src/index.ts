// @x-harness/exec-env：执行环境契约 + localEnv（docs/EXEC-ENV.md）。

export type {
  DirEntry,
  ExecEnv,
  FileStat,
  FileVersion,
  OpenReadResult,
  ProcHandle,
  ReadChunk,
  ReadDirResult,
  ReadFace,
  ReadHandle,
  SpawnFailure,
  SpawnRequest,
  SpawnResult,
  StatResult,
  WriteFileOptions,
  WriteFileResult,
} from "./types.ts";
export { execEnv } from "./tokens.ts";
export { createLocalReadFace } from "./local/read-face.ts";
export { realpathDeep, realpathOrSelf } from "./local/realpath.ts";
export { statLocal } from "./local/stat.ts";
export { openReadLocal, LocalReadHandle } from "./local/open-read.ts";
