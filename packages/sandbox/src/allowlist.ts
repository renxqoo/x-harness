// 白名单合并计算（docs/SANDBOX.md §3）：srt 单代理无连接归属——白名单取并集。
// 成员（插件实例）各自给出有效白名单（off→[]；unrestricted→["*"]；否则 base∪会话授权），
// 任一成员 ["*"] 即全通；同集不触热切换。

/** 并集合并：任一成员 ["*"] → ["*"]（吸收其余） */
export function mergeAllowlists(efforts: readonly (readonly string[])[]): readonly string[] {
  const flat = efforts.flat();
  if (flat.includes("*")) return ["*"];
  return [...new Set(flat)];
}

/** 集合等价（序不敏感、重复无义）——同集不触热切换 */
export function sameDomainSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const d of sa) {
    if (!sb.has(d)) return false;
  }
  return true;
}
