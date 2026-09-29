import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export function realpathDeep(p: string, anchor: string = process.cwd()): string {
  let probe = resolve(anchor, p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch {
      const at = probe.lastIndexOf(sep);
      if (at <= 0) return resolve("/", ...tail);
      tail.unshift(probe.slice(at + 1));
      probe = probe.slice(0, at);
    }
  }
}

export function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
