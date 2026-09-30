import { describe, expect, it } from "vitest";
import { spawnScriptWorker, waitEvent, waitResponse } from "./kit/worker-harness.ts";

async function startWorker(script: readonly unknown[]): Promise<{ worker: ReturnType<typeof spawnScriptWorker> extends Promise<infer W> ? W : never; threadId: string }> {
  const worker = await spawnScriptWorker({ script: script as never });
  worker.send({ type: "thread/start", id: "s1", cwd: worker.agentDir });
  const started = await waitResponse(worker.captured.lines, "thread/start", "s1");
  return { worker, threadId: (started.data as { threadId: string }).threadId };
}

describe("settleAfter turn 锚定（真 worker 驱动）", () => {
  it("solo send 结算自己回合：completed → ok=true（不再 queue-cleared）", async () => {
    const { worker, threadId } = await startWorker([{ delayMs: 300 }, { reply: "ok" }]);
    worker.send({ type: "prompt", id: "solo", threadId, message: "hi" });
    const settled = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "solo");
    expect((settled.payload as { ok?: boolean }).ok).toBe(true);
    worker.input.end();
  }, 30_000);

  it("排队 send 各归各回合：两 send 两帧各自 ok", async () => {
    const { worker, threadId } = await startWorker([{ delayMs: 300 }, { reply: "t0" }, { reply: "t1" }]);
    worker.send({ type: "prompt", id: "f1", threadId, message: "first" });
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    worker.send({ type: "follow_up", id: "f2", threadId, message: "queued" });
    await waitResponse(worker.captured.lines, "follow_up", "f2");
    const s1 = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "f1");
    const s2 = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "f2");
    expect((s1.payload as { ok?: boolean }).ok).toBe(true);
    expect((s2.payload as { ok?: boolean }).ok).toBe(true);
    worker.input.end();
  }, 40_000);

  it("判别：A 成功 + B 自身回合失败 → B ok=false（first-wins 会误报 ok=true）", async () => {
    const { worker, threadId } = await startWorker([{ delayMs: 300 }, { reply: "A-ok" }, { error: { code: "E_TURN_B", message: "b-fails", retryable: false } }]);
    worker.send({ type: "prompt", id: "A", threadId, message: "first" });
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    worker.send({ type: "follow_up", id: "B", threadId, message: "second" });
    await waitResponse(worker.captured.lines, "follow_up", "B");
    const sA = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "A");
    const sB = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "B");
    expect((sA.payload as { ok?: boolean }).ok).toBe(true);
    expect((sB.payload as { ok?: boolean }).ok).toBe(false);
    expect(typeof (sB.payload as { reason?: string }).reason).toBe("string");
    worker.input.end();
  }, 40_000);

  it("判别：steer 并入同回合共享裁决（A/B 同 turn 同 ok=false）", async () => {
    const { worker, threadId } = await startWorker([{ delayMs: 300 }, { error: { code: "E_SHARED", message: "turn-fails", retryable: false } }, { error: { code: "E_SHARED2", message: "turn-fails-2", retryable: false } }, { error: { code: "E_SHARED3", message: "turn-fails-3", retryable: false } }]);
    worker.send({ type: "prompt", id: "A", threadId, message: "first" });
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    worker.send({ type: "steer", id: "B", threadId, message: "inject" });
    await waitResponse(worker.captured.lines, "steer", "B");
    const sA = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "A");
    const sB = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "B");
    expect((sA.payload as { ok?: boolean }).ok).toBe(false);
    expect((sB.payload as { ok?: boolean }).ok).toBe(false);
    worker.input.end();
  }, 40_000);

  it("abort 清队后无回合的排队 send 结算 queue-cleared（假 ok 根除）", async () => {
    const { worker, threadId } = await startWorker([{ delayMs: 60000 }, { reply: "never" }]);
    worker.send({ type: "prompt", id: "g1", threadId, message: "slow" });
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    worker.send({ type: "follow_up", id: "g2", threadId, message: "never-runs" });
    await waitResponse(worker.captured.lines, "follow_up", "g2");
    worker.send({ type: "abort", id: "ab", threadId });
    const settled2 = await waitEvent(worker.captured.lines, "settled", (payload) => (payload as { sendId?: string }).sendId === "g2");
    expect((settled2.payload as { ok?: boolean }).ok).toBe(false);
    expect(["queue-cleared", "client-abort"]).toContain((settled2.payload as { reason?: string }).reason);
    worker.input.end();
  }, 40_000);
});
