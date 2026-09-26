// 恢复协议单测（件16 §5）：终态四分类算法（F8 合成 interrupted）、幂等判据（F7 已材料化）、
// 窗口决策（abnormal 直落/repair 标记判）——纯函数层；全链 kill -9 旅程在 e2e（§12.5⑤ 收口）。

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@x-harness/session";
import { classifyChildTerminal, lastAssistantText, markerMaterialized } from "../resume.ts";

const userMsg = (text: string): SessionEvent => ({ type: "user/message", data: { content: [{ type: "text", text }] } } as never);
const assistantMsg = (text: string): SessionEvent => ({ type: "assistant/message", data: { content: [{ type: "text", text }] } } as never);
const turnStart = (): SessionEvent => ({ type: "turn/start", data: {} } as never);
const turnEnd = (kind: string, extra: Record<string, unknown> = {}): SessionEvent => ({ type: "turn/end", data: { turn: 0, reason: { kind, ...extra } } } as never);

describe("classifyChildTerminal（F8 四分类）", () => {
  it("末 turn/end{completed} → completed", () => {
    expect(classifyChildTerminal([userMsg("go"), turnStart(), assistantMsg('{"a":1}'), turnEnd("completed")])).toEqual({ kind: "completed" });
  });

  it("开放 turn/start（崩溃残留）→ 合成 interrupted——盘上永无 interrupted 字面", () => {
    expect(classifyChildTerminal([userMsg("go"), turnStart(), assistantMsg("partial...")])).toEqual({ kind: "interrupted" });
  });

  it("从未起跑（无 user 消息）→ never-started", () => {
    expect(classifyChildTerminal([])).toEqual({ kind: "never-started" });
    expect(classifyChildTerminal([turnStart(), turnEnd("completed")])).toEqual({ kind: "never-started" });
  });

  it("异常终态 → abnormal 带 detail（error/blocked/未知 fail-closed）", () => {
    expect(classifyChildTerminal([userMsg("go"), turnStart(), turnEnd("error", { message: "boom", code: "network" })])).toEqual({ kind: "abnormal", detail: "boom" });
    expect(classifyChildTerminal([userMsg("go"), turnStart(), turnEnd("blocked", { reason: "denied" })])).toEqual({ kind: "abnormal", detail: "denied" });
    expect(classifyChildTerminal([userMsg("go"), turnStart(), turnEnd("vaporized")])).toEqual({ kind: "abnormal", detail: "vaporized" });
  });

  it("多轮：早轮完成 + 末轮崩溃 → interrupted（不是 completed——旧轮不算交付）", () => {
    const events = [userMsg("one"), turnStart(), assistantMsg("first"), turnEnd("completed"), userMsg("two"), turnStart()];
    expect(classifyChildTerminal(events)).toEqual({ kind: "interrupted" });
  });
});

describe("markerMaterialized（F7 幂等判据）", () => {
  it("标记在已材料化消息 → true；仅在 inbox 事件（未消费）→ false", () => {
    const marker = "[wf task t1 attempt 1]";
    const materialized: SessionEvent[] = [userMsg(`${marker} fix it`)];
    expect(markerMaterialized(materialized, marker)).toBe(true);
    const inboxOnly: SessionEvent[] = [
      { type: "agent/inbox/spliced", data: { op: "insert", entries: [{ id: "x", content: [{ type: "text", text: `${marker} fix` }] }] } } as never,
    ];
    expect(markerMaterialized(inboxOnly, marker)).toBe(false); // 入队 ≠ 送达（F7）
    expect(markerMaterialized([], marker)).toBe(false);
  });
});

describe("lastAssistantText（恢复验收的交付物提取）", () => {
  it("末轮 assistant 文本；无 → undefined", () => {
    expect(lastAssistantText([userMsg("go"), assistantMsg('{"v":1}')])).toBe('{"v":1}');
    expect(lastAssistantText([userMsg("go")])).toBeUndefined();
    expect(lastAssistantText([])).toBeUndefined();
  });
});
