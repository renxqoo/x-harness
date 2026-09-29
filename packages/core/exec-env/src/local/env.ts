import { resolve } from "node:path";
import type { ExecEnv } from "../types.ts";
import { realpathDeep, realpathOrSelf } from "./realpath.ts";
import { statLocal } from "./stat.ts";
import { openReadLocal } from "./open-read.ts";
import { writeFileAtomicLocal } from "./write-file.ts";
import { readDirLocal } from "./read-dir.ts";
import { spawnLocal } from "./spawn.ts";

export function createLocalEnv(root: string): ExecEnv {
  const rootReal = realpathOrSelf(resolve(root));
  return {
    kind: "local",
    root: rootReal,
    realpath: async (p) => realpathDeep(p, rootReal),
    stat: async (p) => statLocal(p),
    openRead: async (p) => openReadLocal(p),
    writeFileAtomic: async (p, content, opts) => writeFileAtomicLocal(p, content, opts),
    readDir: async (p) => readDirLocal(p),
    spawn: async (req) => spawnLocal(req),
  };
}
