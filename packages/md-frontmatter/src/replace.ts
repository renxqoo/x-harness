// frontmatter 头内扁平字段替换：替换 head 中该键**最后一次**出现的行（与 parseFlat
// 的 last-wins 读取语义同义），头体其余字节原样保留（逐字节重建：`---\n` + head +
// `\n---\n` + body 即 splitFrontmatter 的逆）。无 frontmatter / 键缺席 / 键值形态
// 非法 → undefined（不猜、不重建头、不部分改写）。

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
