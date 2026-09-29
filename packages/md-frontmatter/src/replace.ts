import { splitFrontmatter } from "./split.ts";

export function replaceFlatField(text: string, key: string, value: string): string | undefined {
  if (key === "" || key.trim() !== key || key.includes(":")) return undefined;
  if (value.includes("\n") || value.includes("\r")) return undefined;
  const parts = splitFrontmatter(text);
  if (parts === undefined) return undefined;
  const lines = parts.head.split("\n");
  let target = -1;
  for (const [at, line] of lines.entries()) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim() === key) target = at;
  }
  if (target < 0) return undefined;
  lines[target] = `${key}: ${value}`;
  return `---\n${lines.join("\n")}\n---\n${parts.body}`;
}
