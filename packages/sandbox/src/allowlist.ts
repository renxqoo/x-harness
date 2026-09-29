export function mergeAllowlists(efforts: readonly (readonly string[])[]): readonly string[] {
  const flat = efforts.flat();
  if (flat.includes("*")) return ["*"];
  return [...new Set(flat)];
}

export function sameDomainSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const d of sa) {
    if (!sb.has(d)) return false;
  }
  return true;
}
