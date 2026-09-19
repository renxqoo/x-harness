// stat 契约实现（docs/EXEC-ENV.md §1）：EACCES/EPERM 显式判别（FS_ACCESS_DENIED 语义依赖），
// 其余（ENOENT/ENOTDIR/垃圾路径）降级 not_found——垃圾输入返回空形态，不崩溃。

import { statSync } from "node:fs";
import type { FileStat, FileVersion, StatResult } from "../types.ts";

function versionOf(st: { ino: bigint; size: bigint; mtimeNs: bigint }): FileVersion {
  return { ino: st.ino.toString(), size: st.size.toString(), mtimeNs: st.mtimeNs.toString() };
}

function kindOf(st: { isFile(): boolean; isDirectory(): boolean }): FileStat["kind"] {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

export function statLocal(p: string): StatResult {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "access_denied" };
    return { ok: false, reason: "not_found" };
  }
  const big = st as unknown as { ino: bigint; size: bigint; mtimeNs: bigint; isFile(): boolean; isDirectory(): boolean };
  const stat: FileStat = {
    kind: kindOf(big),
    size: Number(big.size),
    version: versionOf(big),
  };
  return { ok: true, stat };
}
