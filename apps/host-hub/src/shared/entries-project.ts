// WAL 事件 → wire 条目投影（DESIGN §3.3）：SessionEvent {type, seq, time, data,
// surfaceOp?} → {seq, ts, event:{type, ...data, (surfaceOp)}}。worker get_entries
// 与 host 直读共用单份（形状闭合是 §3.4 矩表直读路径的验收面）。
import type { SessionEvent } from "@x-harness/session";

export interface EntryLine {
  seq: number;
  ts: number;
  event: Record<string, unknown>;
}

export function projectEntry(event: SessionEvent): EntryLine {
  return {
    seq: event.seq,
    ts: event.time,
    // type 后置——data 内多余键（伪造卷）不得遮蔽真实事件类型
    event: { ...(event.data as Record<string, unknown>), type: event.type, ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}) },
  };
}

export function projectEntries(events: readonly SessionEvent[]): EntryLine[] {
  return events.map(projectEntry);
}

// ---------------------------------------------------------------------------
// history 视图谓词（单真相——worker 与直读两站点共用；docs/SESSION.md 三视图分域）。
// 谓词必须读 journal 信封的 SessionEvent.surfaceOp（投影前），不得读投影后
// line.event.surfaceOp——projectEntry 的 data 展开可让伪造 data 键冒充 surfaceOp。
// 判别形态与 gates.ts parseSurfaceOp 闭合词表一致：字符串 "append" / 对象
// {op:"replace",startSeq,endSeq}；JSON 往返不产生其它形态。

export type EntriesView = "journal" | "history";

/** view 参数运行时门（非法值显式拒绝——静默回落 journal 会掩盖客户端拼写错误） */
export function parseEntriesView(value: unknown): EntriesView | undefined {
  return value === "journal" || value === "history" ? value : undefined;
}

/** replace 载体判定：单点（startSeq===endSeq）= L1 占位 / system 锚点漂移；
 *  区间（startSeq<endSeq）= compaction 摘要 / L2 账本 */
function replaceSpanOf(event: SessionEvent): { startSeq: number; endSeq: number } | undefined {
  const op = event.surfaceOp;
  if (typeof op !== "object" || op === null) return undefined;
  if (op.op !== "replace") return undefined;
  return { startSeq: op.startSeq, endSeq: op.endSeq };
}

/** history 视图行变换：单点 replace 载体行**滤除**（被替换原文永远在场——journal
 *  append-only；占位对人是噪音，零信息损失）；区间 replace 载体行**降级**为单行
 *  elide 标记（摘要正文只存在于载体行，整条滤除会让 history 出现无标记断裂带，
 *  且 turn/step 元数据回跳会被误读为丢数据）。返回 undefined = 滤除。 */
export function historyLineOf(event: SessionEvent): EntryLine | undefined {
  const span = replaceSpanOf(event);
  if (span === undefined) return projectEntry(event);
  if (span.startSeq === span.endSeq) return undefined;
  return {
    seq: event.seq,
    ts: event.time,
    event: { type: "compaction/elided", startSeq: span.startSeq, endSeq: span.endSeq },
  };
}

/** history 行列表（视图=压缩前原文投影；调用方仍在**全集**上做窗口校验/切片，
 *  本函数只变换返回条目——leafSeq/hasMore/cursor 域恒 journal） */
export function historyLines(events: readonly SessionEvent[]): EntryLine[] {
  const lines: EntryLine[] = [];
  for (const event of events) {
    const line = historyLineOf(event);
    if (line !== undefined) lines.push(line);
  }
  return lines;
}
