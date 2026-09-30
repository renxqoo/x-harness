export function truncateBytes(text: string, cap: number, marker = "…"): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > cap) {
    return { text: cutToBytes(text, cap), truncated: true };
  }
  return { text: `${cutToBytes(text, cap - markerBytes)}${marker}`, truncated: true };
}

export function tailBytes(text: string, cap: number, marker = "…"): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= cap) {
    return { text: cutFromTail(text, cap), truncated: true };
  }
  return { text: `${marker}${cutFromTail(text, cap - markerBytes)}`, truncated: true };
}

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
