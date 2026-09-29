const CJK_CODE_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x30ff],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
  [0x20000, 0x2a6df],
];

function isCjkCodePoint(code: number): boolean {
  return CJK_CODE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

export function estimateTokensTypical(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++;
    if (isCjkCodePoint(code)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}
