import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const CASE_FOLD = process.platform === "darwin";

function fold(s: string): string {
  return CASE_FOLD ? s.toLowerCase() : s;
}

function expand(pattern: string, root: string): string {
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~\\")) return join(homedir(), pattern.slice(2));
  if (pattern.startsWith("/") || isAbsolute(pattern)) return pattern;
  return resolve(root, pattern);
}

export interface GlobOpts {
  readonly root: string;
  readonly caseFold?: boolean;
}

export function matchGlob(pattern: string, path: string, opts: GlobOpts): boolean {
  const p = expand(pattern, opts.root);
  const pSegs = p.split(sep).filter((s) => s !== "");
  const tSegs = path.split(sep).filter((s) => s !== "");
  if (opts.caseFold !== true) return matchSegs(pSegs, tSegs);
  return matchSegs(pSegs.map(fold), tSegs.map(fold));
}

export function globMatch(pattern: string, path: string, root: string): boolean {
  return matchGlob(pattern, path, { root, caseFold: CASE_FOLD });
}

function matchSegs(pat: readonly string[], segs: readonly string[]): boolean {
  if (pat.length === 0) return segs.length === 0;
  const [head, ...rest] = pat;
  if (head === "**") {
    for (let skip = 0; skip <= segs.length; skip++) {
      if (matchSegs(rest, segs.slice(skip))) return true;
    }
    return false;
  }
  if (head === undefined) return segs.length === 0;
  const [first, ...tail] = segs;
  if (first === undefined) return false;
  return segMatch(head, first) && matchSegs(rest, tail);
}

function segMatch(patSeg: string, seg: string): boolean {
  const parts = patSeg.split("*");
  const head = parts[0] ?? "";
  if (parts.length === 1) return patSeg === seg;
  if (!seg.startsWith(head)) return false;
  let at = head.length;
  const lastIndex = parts.length - 1;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === lastIndex && part !== "") {
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
