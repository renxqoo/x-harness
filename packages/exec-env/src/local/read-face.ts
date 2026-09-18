// localEnv read 面组装（docs/EXEC-ENV.md §2）：B0 垂直切片——realpath/stat/openRead；
// B1 在此基础上长出 writeFileAtomic/readDir/spawn 成全量 ExecEnv。

import { resolve } from "node:path";
import type { ReadFace } from "../types.ts";
import { realpathDeep, realpathOrSelf } from "./realpath.ts";
import { statLocal } from "./stat.ts";
import { openReadLocal } from "./open-read.ts";

export function createLocalReadFace(root: string): ReadFace {
  return {
    kind: "local",
    root: realpathOrSelf(resolve(root)),
    realpath: async (p) => realpathDeep(p),
    stat: async (p) => statLocal(p),
    openRead: async (p) => openReadLocal(p),
  };
}
