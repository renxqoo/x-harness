import { stepKeyOf, type OpenStep, type OpenTool, type OpenTurn, type SessionFold } from "./fold.ts";
import type { SpanRow } from "./types.ts";

interface Anchor {
  readonly turn: number;
  readonly step: number;
}

const anchorNum = (value: unknown): number => (typeof value === "number" ? value : -1);

class OpenStateCollector {
  openTurn: OpenTurn | undefined;
  openStep: OpenStep | undefined;
  readonly openTools = new Map<string, OpenTool>();
  readonly lastLlm = new Map<string, SpanRow>();
  private readonly lastLlmAttempt = new Map<string, number>();

  scan(row: SpanRow): void {
    const attrs = row.attributes as Record<string, unknown>;
    const anchor = { turn: anchorNum(attrs["xh.turn"]), step: anchorNum(attrs["xh.step"]) };
    if (row.endMs !== null) {
      this.trackClosedLlm(row, anchor);
      return;
    }
    this.trackOpen(row, attrs, anchor);
  }

  private trackOpen(row: SpanRow, attrs: Record<string, unknown>, anchor: Anchor): void {
    if (row.name === "turn" && (this.openTurn === undefined || anchor.turn >= this.openTurn.turn)) this.openTurn = { spanId: row.spanId, turn: anchor.turn, startMs: row.startMs };
    else if (row.name === "step" && (this.openStep === undefined || anchor.step >= this.openStep.step)) this.openStep = { spanId: row.spanId, turn: anchor.turn, step: anchor.step, startMs: row.startMs, parentSpanId: row.parentSpanId ?? "" };
    else if (row.name.startsWith("tool.")) this.trackOpenTool(row, attrs, anchor);
  }

  private trackOpenTool(row: SpanRow, attrs: Record<string, unknown>, anchor: Anchor): void {
    const callId = attrs["tool.call_id"];
    if (typeof callId === "string") {
      this.openTools.set(callId, { spanId: row.spanId, name: row.name.slice("tool.".length), turn: anchor.turn, step: anchor.step, startMs: row.startMs, parentSpanId: row.parentSpanId ?? "" });
    }
  }

  private trackClosedLlm(row: SpanRow, anchor: Anchor): void {
    if (row.name !== "llm.chat") return;
    const key = stepKeyOf(anchor.turn, anchor.step);
    const attrs = row.attributes as Record<string, unknown>;
    const attempt = typeof attrs["xh.attempt"] === "number" ? attrs["xh.attempt"] : 0;
    if (attempt >= (this.lastLlmAttempt.get(key) ?? -1)) {
      this.lastLlmAttempt.set(key, attempt);
      this.lastLlm.set(key, row);
    }
  }
}

export function rebuildSessionFold(params: {
  readonly sessionId: string;
  readonly traceId: string;
  readonly cursor: number;
  readonly includeBodies: boolean;
  readonly spans: readonly SpanRow[];
}): SessionFold {
  const sessionSpans = params.spans.filter((row) => row.name === "session");
  const sessionSpan = sessionSpans[0];
  const collector = new OpenStateCollector();
  for (const row of [...params.spans].sort((a, b) => a.startMs - b.startMs)) collector.scan(row);
  return {
    sessionId: params.sessionId,
    includeBodies: params.includeBodies,
    traceId: params.traceId,
    sessionSpanId: sessionSpan?.spanId ?? "",
    sessionStartMs: sessionSpan?.startMs ?? 0,
    sessionAttrs: sessionSpan !== undefined ? { ...(sessionSpan.attributes as Record<string, unknown>) } : {},
    cursor: params.cursor,
    openTurn: collector.openTurn,
    openStep: collector.openStep,
    openTools: collector.openTools,
    headerTs: new Map(),
    llmAttrs: new Map(),
    llmCount: new Map(),
    lastLlm: collector.lastLlm,
    sessionClosed: sessionSpans.length > 0 && sessionSpans.every((row) => row.endMs !== null),
  };
}
