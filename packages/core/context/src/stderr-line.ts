
/** 一行留痕：内核统一留痕面走 console.error（Node 下即 stderr，浏览器同参可达）。
 *  留痕失败静默降级（§2.4 同口径：观察者失败不得中断主流程或吞调用方根因）——
 *  console.error 是宿主可覆写面，故在通道体收敛防护。 */
export function stderrLine(message: string): void {
  try {
    console.error(message);
  } catch {
    // 静默：无替代归宿可写
  }
}
