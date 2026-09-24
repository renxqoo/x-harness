// WAL 折叠查询（docs/WORK-ERROR-RECOVERY.md C5）：清零与死类判定的账本输入——
// 「从事件现折」模式（count.ts/occupancy.ts 同款），插件无独立可变账本（resume 安全）。

import type { SessionEvent } from "@x-harness/session";

/** compaction 自愈账本（C 审查通道）：扫描卷内 replace 型 user/message（compaction 摘要
 *  落账形态——compact.ts landSummary；occupancy.ts compactionBaselineSeq 同源判据）。
 *  在场 = 本会话至少压缩过一次（「context 超限且 compaction 已自愈过」的下半谓词）。 */
export function hasCompactionLedger(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    const op = event.surfaceOp;
    if (typeof op === "object" && op !== null && op.op === "replace") return true;
  }
  return false;
}

/** 本次 settle（turn/step）的工具结果全 isError 判定（agentTurnConclude 挂载面输入）：
 *  有 tool/result 且全部 isError=true → true；无工具结果（派发面异常/载荷缺工具信息）→
 *  false（判据不成立即让位——不把「无证据」当「全败」）。 */
export function allToolResultsErrored(events: readonly SessionEvent[], at: { readonly turn: number; readonly step: number }): boolean {
  let total = 0;
  let errored = 0;
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    if (event.data.turn !== at.turn || event.data.step !== at.step) continue;
    total += 1;
    if (event.data.isError === true) errored += 1;
  }
  return total > 0 && total === errored;
}
