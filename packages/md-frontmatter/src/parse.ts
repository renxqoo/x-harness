export function parseFlat(head: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const line of head.split("\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const key = line.slice(0, colon).trim();
    if (key === "") return undefined;
    out.set(key, line.slice(colon + 1).trim());
  }
  return out;
}
