// 路径 glob 匹配（Read/Write 规则面（Grep 已并入 Read——2026-09-28 断代））：`**` 跨段递归（含目录自身）、`*` 段内、`~` 展开到家目录、
// 相对 pattern 以 root 解析。段边界语义与 fail-safe 过拒：`/*` 前缀匹配嵌套也命中（my-agent 文档化过拒）。
// 平台大小写（2026-09-29 红队 P0-2）：darwin 默认 APFS 大小写不敏感——底线/习得闸匹配经 caseFold
// 归一（deny 面从严：Sudo/suDO/~/.SSH 变体与正形同拒）；linux 默认敏感保持原样。

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** 平台大小写归一开关（底线/习得闸消费——darwin 默认 APFS 不敏感：deny 面从严；
 *  调用方显式传参，与平台常量分离便于测试跨平台钉锚） */
export const CASE_FOLD = process.platform === "darwin";

function fold(s: string): string {
  return CASE_FOLD ? s.toLowerCase() : s;
}

function expand(pattern: string, root: string): string {
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~\\")) return join(homedir(), pattern.slice(2));
  if (pattern.startsWith("/") || isAbsolute(pattern)) return pattern;
  return resolve(root, pattern); // 相对 pattern 以工作区根解析
}

/** glob → 判定选项：root=解析基（相对 pattern 以工作区根解析）；caseFold=true 段比较
 *  大小写归一（darwin 底线面） */
export interface GlobOpts {
  readonly root: string;
  readonly caseFold?: boolean;
}

/** glob → 判定：段级展开，** 匹配任意段序列（含空）；* 匹配单段内任意非 / 字符 */
export function matchGlob(pattern: string, path: string, opts: GlobOpts): boolean {
  const p = expand(pattern, opts.root);
  const pSegs = p.split(sep).filter((s) => s !== "");
  const tSegs = path.split(sep).filter((s) => s !== "");
  if (opts.caseFold !== true) return matchSegs(pSegs, tSegs);
  return matchSegs(pSegs.map(fold), tSegs.map(fold));
}

/** 向后兼容入口：三参核心形态（caseFold 经平台常量 CASE_FOLD——底线/习得闸消费） */
export function globMatch(pattern: string, path: string, root: string): boolean {
  return matchGlob(pattern, path, { root, caseFold: CASE_FOLD });
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
  const lastIndex = parts.length - 1;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === lastIndex && part !== "") {
      // 尾锚（2026-09-29 红队 P0-1）：星后缀后不得再挂字符——旧实现 a*b 命中 aXbY（test*.bak 放行 testX.bakZ）
      if (!seg.slice(at).endsWith(part)) return false;
      at = seg.length;
      continue;
    }
    const found = seg.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}
