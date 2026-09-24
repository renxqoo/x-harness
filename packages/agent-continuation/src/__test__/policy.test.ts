// 策略与计数折叠单测（docs/OUTPUT-TOKEN-CONTINUATION.md 测试口径「agent-continuation 插件」节）。

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@x-harness/session";
import { continuationsSinceStop } from "../count.ts";
import { decideContinuation, GIVE_UP, OUTPUT_CONTINUATION_INSTRUCTION, OUTPUT_CONTINUATION_SOURCE, validateMaxOutputContinuations } from "../policy.ts";

const idleSignal = (): AbortSignal => new AbortController().signal;

describe("decideContinuation（count/max 矩阵与判定）", () => {
  it("count < max → resume（指令/source 常量逐字节）；count ≥ max → fail（GIVE_UP 常量）", () => {
    const resume = decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], count: 0, max: 3 });
    expect(resume).toEqual({ kind: "resume", source: OUTPUT_CONTINUATION_SOURCE, instruction: OUTPUT_CONTINUATION_INSTRUCTION });
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], count: 2, max: 3 })?.kind).toBe("resume");
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], count: 3, max: 3 })).toEqual(GIVE_UP);
    expect(GIVE_UP).toEqual({ kind: "fail", message: "The model's response exceeded the output token maximum.", code: "output-token-limit" });
  });

  it("可续写信号（回归·用户实报 MiMo 思考型截断）：content 空但有 thinking → 续写；两者皆空才让位", () => {
    // 预算全烧在思考上、正文零产出——指令「拆小块」正是对症，必须续写而非静默收轮
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [], hasThinking: true, count: 0, max: 3 })?.kind).toBe("resume");
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [], count: 0, max: 3 })).toBeUndefined();
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [], hasThinking: true, count: 3, max: 3 })).toEqual(GIVE_UP);
  });

  it("带工具让位（WER 批 A）：hasTools=true → undefined——计数再低也不续（工具结果待消化，让位 final 等价旧粘性）", () => {
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], hasTools: true, truncatedCount: 1, count: 0, max: 3 })).toBeUndefined();
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [], hasThinking: true, hasTools: true, count: 0, max: 3 })).toBeUndefined();
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], hasTools: false, count: 0, max: 3 })?.kind).toBe("resume"); // 无工具不受扰
  });

  it("max=0 → 首次截断即放弃；非截断让位；signal 断让位", () => {
    expect(decideContinuation({ stopReason: "max-tokens", signal: idleSignal(), content: [{ type: "text", text: "partial" }], count: 0, max: 0 })).toEqual(GIVE_UP);
    expect(decideContinuation({ stopReason: "stop", signal: idleSignal(), content: [{ type: "text", text: "partial" }], count: 0, max: 3 })).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(decideContinuation({ stopReason: "max-tokens", signal: controller.signal, content: [{ type: "text", text: "partial" }], count: 0, max: 3 })).toBeUndefined();
  });

  it("validateMaxOutputContinuations：缺省 3；0 合法；负数/非整数 fail-loud", () => {
    expect(validateMaxOutputContinuations(undefined)).toBe(3);
    expect(validateMaxOutputContinuations(0)).toBe(0);
    expect(() => validateMaxOutputContinuations(-1)).toThrow(/non-negative integer/);
    expect(() => validateMaxOutputContinuations(1.5)).toThrow(/non-negative integer/);
  });
});

function event(type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq: 0, time: 1, data } as never;
}

const DIRECTIVE = event("agent/message", { turn: 0, step: 0, source: OUTPUT_CONTINUATION_SOURCE, kind: "directive", content: [] });
const FOREIGN = event("agent/message", { turn: 0, step: 0, source: "delegation-report", kind: "content", content: [] });

describe("continuationsSinceStop（WAL 折叠）", () => {
  it("段内递增；stop settle 复位（段间归零）；turn 边界复位（跨 turn 不串）", () => {
    const stop = event("assistant/message", { turn: 0, step: 0, content: [], stopReason: "stop" });
    expect(continuationsSinceStop([DIRECTIVE, DIRECTIVE, DIRECTIVE], 0)).toBe(3);
    expect(continuationsSinceStop([DIRECTIVE, DIRECTIVE, stop, DIRECTIVE], 0)).toBe(1); // stop 复位后只计新段
    expect(
      continuationsSinceStop(
        [
          DIRECTIVE,
          DIRECTIVE,
          event("turn/start", { turn: 7 }),
          DIRECTIVE,
        ],
        7,
      ),
    ).toBe(1); // turn/start(7) 复位——前 turn 的指令不串
  });

  it("按 source 精确计数：其它来源/非 directive 不计；自愈重试不落 agent/message 故不占额度", () => {
    expect(continuationsSinceStop([FOREIGN, DIRECTIVE], 0)).toBe(1);
    expect(continuationsSinceStop([FOREIGN], 0)).toBe(0);
    const toolStop = event("assistant/message", { turn: 0, step: 1, content: [], stopReason: "stop" });
    expect(continuationsSinceStop([DIRECTIVE, toolStop, DIRECTIVE], 0)).toBe(1); // stop+tool_use 出口同样复位（段间语义）
  });
});
