// 受信命令判定（docs/SANDBOX.md §3）：sh -c 载荷经 permission 的 parseBash（单一解析真相）
// 全段解析——每段命令的 argv0 basename 都在宿主词表内才免围栏。动态展开（argv0 非字面）、
// 命令替换内嵌命令、解析失败 → 一律不受信（fail-closed：围栏照旧）。
// 注入段被 parseBash 递归收进命令列表一并查验——`bw $(curl …)` 的 curl 段同样必须受信。

import { basename } from "node:path";
import { parseBash } from "@x-harness/permission";

export function isTrustedCommand(command: string, trusted: readonly string[]): boolean {
  if (trusted.length === 0 || command.trim() === "") return false;
  const parsed = parseBash(command);
  if (!parsed.ok || parsed.commands.length === 0) return false;
  const set = new Set(trusted);
  return parsed.commands.every((c) => typeof c.argv[0] === "string" && set.has(basename(c.argv[0])));
}
