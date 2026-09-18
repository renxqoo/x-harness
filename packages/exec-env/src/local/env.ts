// 全量 localEnv（docs/EXEC-ENV.md §2）：read 面（B0′）+ write/readDir/spawn 面（B1）组装成 ExecEnv。

import { resolve } from "node:path";
import type { ExecEnv } from "../types.ts";
import { realpathDeep, realpathOrSelf } from "./realpath.ts";
import { statLocal } from "./stat.ts";
import { openReadLocal } from "./open-read.ts";
import { writeFileAtomicLocal } from "./write-file.ts";
import { readDirLocal } from "./read-dir.ts";
import { spawnLocal } from "./spawn.ts";

export function createLocalEnv(root: string): ExecEnv {
  return {
    kind: "local",
    root: realpathOrSelf(resolve(root)),
    realpath: async (p) => realpathDeep(p),
    stat: async (p) => statLocal(p),
    openRead: async (p) => openReadLocal(p),
    writeFileAtomic: async (p, content, opts) => writeFileAtomicLocal(p, content, opts),
    readDir: async (p) => readDirLocal(p),
    spawn: async (req) => spawnLocal(req),
  };
}
