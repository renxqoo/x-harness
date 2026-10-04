import { describe, expect, it } from "vitest";
import { scaledIdleMs } from "../summarize.ts";
import { segmentNodes, summarizeFolded } from "../folded-summarize.ts";
import type { SummarizerFace } from "../summarize.ts";
import { fakeLlm, seedTurn, sid, makeWorld, textScript, promptOf } from "./helpers.ts";
import type { SurfaceNode } from "@x-harness/session";

function nodeOf(seq: number, type: "user/message" | "assistant/message", text: string): SurfaceNode {
  return {
    seq,
    event: {
      type,
      seq,
      time: seq,
      surfaceOp: "append",
      data: { turn: 0, step: 0, content: [{ type: "text", text }] },
    } as never,
  };
}

const userNode = (seq: number, text: string): SurfaceNode => nodeOf(seq, "user/message", text);
const assistantNode = (seq: number, text: string): SurfaceNode => nodeOf(seq, "assistant/message", text);

const FACE: SummarizerFace = { model: "sum", contextWindow: 100_000, maxOutputTokens: 100 };
const FOLD_FACE: SummarizerFace = { model: "sum", contextWindow: 20_000, maxOutputTokens: 100 };

describe("scaledIdleMs", () => {
  it("base 120s + 0.5s/千字符，上限 300s", () => {
    expect(scaledIdleMs(0)).toBe(120_000);
    expect(scaledIdleMs(1_000)).toBe(120_500);
    expect(scaledIdleMs(400_000)).toBe(300_000);
  });
});

describe("segmentNodes", () => {
  it("预算内整段不切；超预算按节点边界切；单节点超预算独占一段（边界：切点不劈开单个消息）", () => {
    const small = [userNode(0, "aaa"), assistantNode(1, "bbb")];
    expect(segmentNodes(small, 10_000)).toHaveLength(1);
    const nodes = [userNode(0, "aaaa"), assistantNode(1, "bbbb"), userNode(2, "cccc"), assistantNode(3, "dddd")];
    const chunks = segmentNodes(nodes, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30 + 40);
    expect(segmentNodes([], 100)).toHaveLength(0);
  });
});

describe("summarizeFolded", () => {
  it("三倍预算的 span → 多次拨号逐段滚动（首段无 previous-summary、后续段携带）；任一段失败整体失败（回归：一次性 70 万 token 请求结构性失败）", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("fold") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 8; turn += 1) {
        seedTurn(made.value, { turn, user: `question-${turn}-`.repeat(60), assistant: { text: `answer-${turn}-`.repeat(120), usage: { input: 10, output: 1 } } });
      }
      const nodes = made.value.surface();
      const fake = fakeLlm();
      for (let i = 0; i < 40; i += 1) fake.scripts.push(textScript(`SEG-SUM-${i}`));
      const outcome = await summarizeFolded({
        llm: fake.runtime,
        face: FOLD_FACE,
        reserveTokens: 500,
        nodes,
        signal: new AbortController().signal,
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      expect(fake.calls.length).toBeGreaterThan(1);
      const second = promptOf(fake.calls[1]);
      expect(second).toContain("<previous-summary>");
      expect(second).toContain("SEG-SUM-0");
      expect(outcome.text).toBe(`SEG-SUM-${fake.calls.length - 1}`);
      const budget = Math.floor((FOLD_FACE.contextWindow - 500) / 1.25) - 2_048;
      const maxNode = Math.max(...nodes.map((n) => (n.event.data as { content?: ReadonlyArray<{ text: string }> }).content?.[0]?.text?.length ?? 0));
      for (const call of fake.calls) {
        const prompt = promptOf(call);
        const convo = prompt.slice(prompt.indexOf("<conversation>") + 14, prompt.indexOf("</conversation>"));
        expect(convo.length).toBeLessThanOrEqual(budget + maxNode + 64);
      }
    } finally {
      await world.ctx.dispose();
    }
  });

  it("中段失败 → 整体失败且原因码透传", async () => {
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("fold-fail") });
      if (!made.ok) throw new Error(made.reason);
      for (let turn = 0; turn < 8; turn += 1) {
        seedTurn(made.value, { turn, user: `question-${turn}-`.repeat(60), assistant: { text: `answer-${turn}-`.repeat(120), usage: { input: 10, output: 1 } } });
      }
      const fake = fakeLlm();
      fake.scripts.push(textScript("FIRST-OK"));
      fake.scripts.push({
        [Symbol.asyncIterator]: () =>
          (async function* () {
            yield { type: "finish", finish: { kind: "error", message: "boom", code: "http-500" } };
          })() as never,
      } as never);
      const outcome = await summarizeFolded({
        llm: fake.runtime,
        face: FOLD_FACE,
        reserveTokens: 500,
        nodes: made.value.surface(),
        signal: new AbortController().signal,
      });
      expect(outcome).toEqual({ ok: false, reason: "failed" });
    } finally {
      await world.ctx.dispose();
    }
  });

  it("预算 < 1 → budget-exhausted（零拨号）", async () => {
    const fake = fakeLlm();
    const outcome = await summarizeFolded({
      llm: fake.runtime,
      face: { ...FACE, contextWindow: 500 },
      reserveTokens: 600,
      nodes: [userNode(0, "x")],
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ ok: false, reason: "budget-exhausted" });
    expect(fake.calls).toHaveLength(0);
  });
});
