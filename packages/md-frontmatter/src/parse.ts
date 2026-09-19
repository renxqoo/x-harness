// 扁平 key: value 解析：每行一个键值（空行跳过），键值两侧 trim；无冒号或空键的
// 行 → undefined（整体拒，不做部分解析）；值为原样字符串（不含结构语义）。

export function parseFlat(head: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  for (const line of head.split("\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return out;
}
