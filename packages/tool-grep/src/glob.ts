const GLOB_EXPAND_CAP = 64;

export function globError(glob: string): string | undefined {
  if (glob.startsWith("!")) return "negative globs are not supported";
  let depth = 0;
  for (const ch of glob) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) return "top-level comma lists are not supported; use brace alternation like *.{ts,tsx}";
  }
  if (expandBraces(glob).length === 0) return "glob expands to too many alternatives (max 64)";
  return undefined;
}

function expandBraces(glob: string, budget: { count: number } = { count: 1 }): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  const close = glob.indexOf("}", open);
  if (close < 0) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const parts = glob.slice(open + 1, close).split(",");
  budget.count *= parts.length;
  if (budget.count > GLOB_EXPAND_CAP) return [];
  return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`, budget));
}
