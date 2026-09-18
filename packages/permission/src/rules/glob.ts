// 路径 glob 匹配（Read/Write/Grep 规则面）：`**` 跨段递归（含目录自身）、`*` 段内、`~` 展开到家目录、
// 相对 pattern 以 root 解析。段边界语义与 fail-safe 过拒：`/*` 前缀匹配嵌套也命中（my-agent 文档化过拒）。

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

function expand(pattern: string, root: string): string {
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~\\")) return join(homedir(), pattern.slice(2));
  if (pattern.startsWith("/") || isAbsolute(pattern)) return pattern;
  return resolve(root, pattern); // 相对 pattern 以工作区根解析
}

/** glob → 判定：段级展开，** 匹配任意段序列（含空）；* 匹配单段内任意非 / 字符 */
export function globMatch(pattern: string, path: string, root: string): boolean {
  const p = expand(pattern, root);
  const pSegs = p.split(sep).filter((s) => s !== "");
  const tSegs = path.split(sep).filter((s) => s !== "");
  return matchSegs(pSegs, tSegs);
}

function matchSegs(pat: readonly string[], segs: readonly string[]): boolean {
  if (pat.length === 0) return segs.length === 0;
  const [head, ...rest] = pat;
  if (head === "**") {
    // ** 匹配任意段序列（含空）——fail-safe 过拒：目录自身与全部嵌套都在射程内
    for (let skip = 0; skip <= segs.length; skip++) {
      if (matchSegs(rest, segs.slice(skip))) return true;
    }
    return false;
  }
  if (head === undefined) return segs.length === 0; // 空模式段只匹配空目标
  const [first, ...tail] = segs;
  if (first === undefined) return false;
  return segMatch(head, first) && matchSegs(rest, tail);
}

function segMatch(patSeg: string, seg: string): boolean {
  const parts = patSeg.split("*");
  const head = parts[0] ?? "";
  if (parts.length === 1) return patSeg === seg; // 无星段=全等（.ssh 不前缀匹配 .sshx）
  if (!seg.startsWith(head)) return false;
  let at = head.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const found = seg.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}
