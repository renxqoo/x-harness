// WAL 事件 → wire 条目投影（DESIGN §3.3）：SessionEvent {type, seq, time, data,
// surfaceOp?} → {seq, ts, event:{type, ...data, (surfaceOp)}}。worker get_entries
// 与 host 直读共用单份（形状闭合是 §3.4 矩表直读路径的验收面）。
import { parseSurfaceOp, type SessionEvent } from "@x-harness/session";

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

/** replace 载体区间（内核 parseSurfaceOp 单源——闭合词表一致性不靠注释靠代码） */
function replaceSpanOf(event: SessionEvent): { startSeq: number; endSeq: number } | undefined {
  const op = parseSurfaceOp(event.surfaceOp);
  if (op === undefined || op === "append") return undefined;
  return { startSeq: op.startSeq, endSeq: op.endSeq };
}

/** history 视图行变换：L1 占位族（`tool/result` 载体——scavenger 单点替换）**滤除**
 *  （被替换原文永远在场——journal append-only；占位对人是噪音，零信息损失）；
 *  其余 replace 载体（compaction 摘要 / L2 账本 / system 锚点漂移）一律**降级**为单行
 *  elide 标记——摘要正文只存在于载体行，整条滤除会让 history 出现无标记断裂带。
 *  分类按**写者类型**不按区间宽度：compaction 切口护栏允许 end===start 的 1 节点
 *  区间（cut > 首候选 且 start=锚点+1 时可达），startSeq===endSeq 不能区分
 *  L1 占位与 1 节点摘要（对抗审查实证）。返回 undefined = 滤除。 */
export function historyLineOf(event: SessionEvent): EntryLine | undefined {
  const span = replaceSpanOf(event);
  if (span === undefined) return projectEntry(event);
  if (event.type === "tool/result") return undefined; // L1 占位族（scavenger 唯一写者）
  // 迭代前缀替换后头部节点携带 journal 尾 seq、其后保留节点 seq 更小——落账的
  // startSeq/endSeq 是**位置**端点的 seq，可数值逆序（surface.ts 区间按位置语义）。
  // wire 消费者按数值区间理解会错杀保留原文——此处规整为数值升序再上 wire。
  const lo = Math.min(span.startSeq, span.endSeq);
  const hi = Math.max(span.startSeq, span.endSeq);
  return {
    seq: event.seq,
    ts: event.time,
    event: { type: "compaction/elided", startSeq: lo, endSeq: hi },
  };
}

