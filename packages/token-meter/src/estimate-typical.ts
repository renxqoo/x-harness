// 典型值口径 token 估算（docs/TOKEN-METER.md §5）：CJK 1 字 ≈ 1 token、其余 ≈ 4 chars/token，
// 码位计长（代理对按一码位）。显示/分析面用（token-analytics 分项估算同源）；
// 预算/压缩面用上界口径 estimateText（plugin.ts——非可打印 ASCII 1.25/字）。
// 两口径各自持判据：本表只覆盖 CJK 区段，西里尔/希腊等非 ASCII 走 other 桶（/4）——
// 判据差异是口径差异不是重复，严禁互串（TOKEN-UNIFICATION.md R2）。

/** CJK 码位区表（CJK 标点+假名/假名补充/扩展 A/基本区/谚文/兼容表意/全角/扩展 B） */
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

/** CJK 码位判定（CJK 文本 1 字 ≈ 1 token） */
function isCjkCodePoint(code: number): boolean {
  return CJK_CODE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/** 典型值估算：CJK 1 字 ≈ 1 token；其余 ≈ 4 chars/token（英文）。中文为主的
 *  系统提示词按 4 chars/token 会系统性低估 ~2.3 倍（分项口径显著失真的根因）。
 *  非字符串降级 0（与 estimateText 同律——垃圾输入不崩）。 */
export function estimateTokensTypical(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++; // 代理对占两码元——按一个码位计
    if (isCjkCodePoint(code)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}
