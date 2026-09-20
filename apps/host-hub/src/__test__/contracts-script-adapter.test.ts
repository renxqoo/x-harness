// script-adapter/entries-project 契约：剧本步消费、耗尽 error-finish、abort 抛
// AbortError、thinking 记录面；wire 条目投影形状。
import { describe, expect, test } from "vitest";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { createScriptAdapter, scriptFromEnv } from "../shared/script-adapter.ts";
import { projectEntries, projectEntry } from "../shared/entries-project.ts";
import type { SessionEvent } from "@x-harness/session";

async function collect(gen: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { model: "script-1", tools: [], messages: [], signal: new AbortController().signal, ...over };
}

describe("script-adapter", () => {
  test("reply 步：text-delta + usage + finish stop（恰一 finish）", async () => {
    const a = createScriptAdapter([{ reply: "hi", thinking: "deep" }]);
    const chunks = await collect(a.stream(request()));
    expect(chunks.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(chunks).toContainEqual({ type: "thinking-delta", text: "deep" });
    expect(chunks).toContainEqual({ type: "text-delta", text: "hi" });
    expect(a.consumed).toBe(1);
  });

  test("toolCalls 步：callId/name/argumentsDelta 全量", async () => {
    const a = createScriptAdapter([{ toolCalls: [{ name: "bash", input: '{"command":"ls"}' }] }]);
    const chunks = await collect(a.stream(request()));
    expect(chunks).toContainEqual({ type: "tool-call-delta", index: 0, callId: "call-1-0", name: "bash", argumentsDelta: '{"command":"ls"}' });
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "stop" } });
  });

  test("error 步：error-finish 携带 code（llm-retry 判据面）", async () => {
    const a = createScriptAdapter([{ error: { code: "http-429", message: "rate limited" } }]);
    const chunks = await collect(a.stream(request()));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "rate limited", code: "http-429" } });
  });

  test("delayMs 步在调用内睡眠后终结（delay 不消耗 LLM 调用语义位）", async () => {
    const a = createScriptAdapter([{ delayMs: 20 }, { reply: "late" }]);
    const started = Date.now();
    const chunks = await collect(a.stream(request()));
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(chunks).toContainEqual({ type: "text-delta", text: "late" });
    expect(a.consumed).toBe(1);
  });

  test("耗尽 → empty-response error-finish；thinking 记录面", async () => {
    const a = createScriptAdapter();
    const chunks = await collect(a.stream(request({ thinking: "high" })));
    expect(chunks.at(-1)).toEqual({ type: "finish", finish: { kind: "error", message: "empty-response", code: "empty-response" } });
    expect(a.lastThinking).toBe("high");
  });

  test("abort：delay 睡眠中抛 AbortError（对齐内核 abort 契约）", async () => {
    const a = createScriptAdapter([{ delayMs: 5_000 }, { reply: "never" }]);
    const controller = new AbortController();
    const pending = collect(a.stream(request({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("scriptFromEnv：JSON 内联；缺席/坏 JSON = 空剧本", () => {
    expect(scriptFromEnv({ HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]) })).toEqual([{ reply: "x" }]);
    expect(scriptFromEnv({})).toEqual([]);
    expect(scriptFromEnv({ HUB_WORKER_SCRIPT: "junk" })).toEqual([]);
    expect(scriptFromEnv({ HUB_WORKER_SCRIPT: '"str"' })).toEqual([]);
  });
});

describe("entries-project", () => {
  test("SessionEvent → wire 条目（type 摊平 + surfaceOp 随附）", () => {
    const event = {
      type: "user/message",
      seq: 3,
      time: 1234,
      data: { turn: 1, step: 0, content: [{ type: "text", text: "hi" }] },
      surfaceOp: "append",
    } as SessionEvent;
    expect(projectEntry(event)).toEqual({
      seq: 3,
      ts: 1234,
      event: { type: "user/message", turn: 1, step: 0, content: [{ type: "text", text: "hi" }], surfaceOp: "append" },
    });
    const bare = { type: "turn/start", seq: 0, time: 5, data: { turn: 1 } } as SessionEvent;
    expect(projectEntry(bare)).toEqual({ seq: 0, ts: 5, event: { type: "turn/start", turn: 1 } });
    expect(projectEntries([bare, event])).toHaveLength(2);
  });
});
