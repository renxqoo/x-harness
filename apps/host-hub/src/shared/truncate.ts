// 字节截断（DESIGN §3.3/§3.7）：在途尾部与直执行输出共享。不劈代理对；
// marker 守预算（marker 宽于 cap 时退化为无 marker 切头——上限恒成立，
// 退化条件是 `>` 不是 `>=`，等值合法不误伤）。
export function truncateBytes(text: string, cap: number, marker = "…"): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > cap) {
    // 无 marker 空间：纯切头（丢头保尾语义由调用方反转字符串后使用 tailBytes）
    return { text: cutToBytes(text, cap), truncated: true };
  }
  return { text: `${cutToBytes(text, cap - markerBytes)}${marker}`, truncated: true };
}

/** 丢头保尾（尾部预判语义）：从尾部累计取至多 cap 字节，不劈代理对 */
export function tailBytes(text: string, cap: number, marker = "…"): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= cap) {
    return { text: cutFromTail(text, cap), truncated: true };
  }
  return { text: `${marker}${cutFromTail(text, cap - markerBytes)}`, truncated: true };
}

/** 从头截取至多 maxBytes 的前缀（代理对安全） */
export function cutToBytes(text: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

/** 从尾截取至多 maxBytes 的后缀（代理对安全） */
export function cutFromTail(text: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of Array.from(text).reverse()) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > maxBytes) break;
    out = ch + out;
    used += b;
  }
  return out;
}
