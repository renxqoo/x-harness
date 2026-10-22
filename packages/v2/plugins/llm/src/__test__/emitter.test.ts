import { expect, it } from "vitest";
import { createEmitter } from "../stream/create-emitter";
import { createLlmControl } from "../domain/create-control";
import { readLlmLimits } from "../provider";
import type { LlmEvent, LlmResult } from "../contracts";

function value<T>(result: LlmResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

const error = {
  source: "llm",
  code: "capacity-exceeded",
  phase: "stream",
  hasOutput: false,
} as const;
it("event budget includes one terminal and rejected events do not consume a public sequence", async () => {
  const control = createLlmControl({ signals: [], timeoutMs: 100 });
  const events: LlmEvent[] = [];
  const emitter = createEmitter({
    requestId: "test",
    limits: value(readLlmLimits({ maxEvents: 3 })),
    control,
    onEvent(event) {
      events.push(event);
    },
  });

  try {
    value(await emitter.emit({ type: "start", provider: "p", model: "m" }));
    value(await emitter.emit({ type: "block-start", block: { kind: "text", id: "t" } }));
    expect(await emitter.emit({ type: "text-delta", id: "t", delta: "too many" })).toMatchObject({
      ok: false,
      error: { code: "capacity-exceeded" },
    });
    value(await emitter.emit({ type: "error", error }));
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(events.at(-1)?.type).toBe("error");
    expect(emitter.usable()).toBe(false);
  } finally {
    emitter.close();
    control.close();
  }
});
it("byte-budget rejection preserves consecutive numbering for the error terminal", async () => {
  const control = createLlmControl({ signals: [], timeoutMs: 100 });
  const events: LlmEvent[] = [];
  const emitter = createEmitter({
    requestId: "test",
    limits: value(readLlmLimits({ maxOutputBytes: 512 })),
    control,
    onEvent(event) {
      events.push(event);
    },
  });

  try {
    value(await emitter.emit({ type: "start", provider: "p", model: "m" }));
    expect((await emitter.emit({ type: "text-delta", id: "t", delta: "x".repeat(1000) })).ok).toBe(
      false,
    );
    value(await emitter.emit({ type: "error", error }));
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
  } finally {
    emitter.close();
    control.close();
  }
});
