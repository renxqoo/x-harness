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
  ReadDirFace,
  ReadFace,
  ReadHandle,
  SpawnFailure,
  SpawnRequest,
  SpawnResult,
  StatResult,
  WriteFace,
  WriteFileOptions,
  WriteFileResult,
} from "./types.ts";
export { execEnv } from "./tokens.ts";
export { createLocalEnv } from "./local/env.ts";
export { createLocalEnvPlugin } from "./local/plugin.ts";
export type { LocalEnvPluginOptions } from "./local/plugin.ts";
export { realpathDeep, realpathOrSelf } from "./local/realpath.ts";
export { statLocal } from "./local/stat.ts";
export { openReadLocal, LocalReadHandle } from "./local/open-read.ts";
export { writeFileAtomicLocal } from "./local/write-file.ts";
export { readDirLocal } from "./local/read-dir.ts";
export { spawnLocal } from "./local/spawn.ts";
