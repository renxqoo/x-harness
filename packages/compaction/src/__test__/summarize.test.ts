// 摘要 side-call 终态矩阵（docs/COMPACTION.md §1.1；对照参照系 hardening 语义子集：
// 承接 H1 截断丢弃/H2 输入硬界/H4 provider 错与空输出/abort 静默/看门狗挂死跳过/
// budget 耗尽不拨号/thinking-only 空摘要；改写为 LlmChunk finish 词表）。

import { describe, expect, it } from "vitest";
import type { SummarizerFace } from "../summarize.ts";
import { buildSummarizePrompt, summaryInputMaxChars, summarize } from "../summarize.ts";
import { errorScript, emptyScript, fakeLlm, hangScript, textScript, thinkingOnlyScript, truncatedScript } from "./helpers.ts";

const face: SummarizerFace = { model: "sum", contextWindow: 100_000, maxOutputTokens: 8_000 };
const signal = new AbortController().signal;

function run(script: AsyncGenerator<import("@x-harness/llm").LlmChunk>, overrides?: Partial<Parameters<typeof summarize>[0]>) {
  const fake = fakeLlm();
  fake.scripts.push(script);
  return summarize({
    llm: fake.runtime,
    face,
    reserveTokens: 16_384,
    conversation: "[User]: hello",
    signal,
    idleTimeoutMs: 0,
    ...overrides,
  } as Parameters<typeof summarize>[0]);
}

describe("summaryInputMaxChars（H2 输入硬界）", () => {
  it("分母 = 摘要窗 − reserve − 4_000 − 上份摘要 − 附加指令；按 1.25 折算", () => {
    const base = summaryInputMaxChars({ face, reserveTokens: 10_000 });
    expect(base).toBe(Math.floor((100_000 - 10_000 - 4_000) / 1.25));
    expect(summaryInputMaxChars({ face: { ...face, contextWindow: 12_000 }, reserveTokens: 10_000 })).toBe(-1_600); // 挂账#4：按摘要窗推导；< 1 = 预算耗尽
    expect(
      summaryInputMaxChars({ face, reserveTokens: 10_000, previousSummary: "x".repeat(1_000), customInstructions: "y".repeat(500) }),
    ).toBe(Math.floor((100_000 - 10_000 - 4_000 - 1_000 - 500) / 1.25));
  });
});

describe("buildSummarizePrompt", () => {
  it("conversation 包裹 + previous-summary 分节 + 累积更新指令 + 附加聚焦", () => {
    const prompt = buildSummarizePrompt({ conversation: "hello", maxChars: 100, previousSummary: "prev", customInstructions: "focus-on-x" });
    expect(prompt).toContain("<conversation>\nhello\n</conversation>");
    expect(prompt).toContain("<previous-summary>\nprev\n</previous-summary>");
    expect(prompt).toContain("PRESERVE all existing information");
    expect(prompt).toContain("Additional focus: focus-on-x");
    const initial = buildSummarizePrompt({ conversation: "hello", maxChars: 100 });
    expect(initial).not.toContain("previous-summary");
    expect(initial).not.toContain("PRESERVE");
  });
});

describe("终态矩阵", () => {
  it("stop → 全文", async () => {
    const outcome = await run(textScript("SUMMARY-BODY"));
    expect(outcome).toEqual({ ok: true, text: "SUMMARY-BODY" });
  });

  it("max-tokens（H1）→ 截断丢弃（replace 不可逆——残缺摘要不落账）", async () => {
    expect(await run(truncatedScript("partial"))).toEqual({ ok: false, reason: "truncated" });
  });

  it("provider 错（H4）→ failed；abort（联动）→ aborted 静默", async () => {
    expect(await run(errorScript("http-500"))).toEqual({ ok: false, reason: "failed" });
    const aborting = new AbortController();
    aborting.abort();
    const outcome = await run(errorScript("http-500"), { signal: aborting.signal });
    expect(outcome).toEqual({ ok: false, reason: "aborted" });
  });

  it("空输出 / thinking-only → empty（thinking-delta 不计正文）", async () => {
    expect(await run(emptyScript())).toEqual({ ok: false, reason: "empty" });
    expect(await run(thinkingOnlyScript("deep-thoughts"))).toEqual({ ok: false, reason: "empty" });
  });

  it("预算耗尽 → 不拨号（budget-exhausted，无 LLM 调用）", async () => {
    const fake = fakeLlm();
    const outcome = await summarize({
      llm: fake.runtime,
      face: { ...face, contextWindow: 10_000 },
      reserveTokens: 9_000,
      conversation: "x",
      signal,
      idleTimeoutMs: 0,
    });
    expect(outcome).toEqual({ ok: false, reason: "budget-exhausted" });
    expect(fake.calls).toHaveLength(0);
  });

  it("流抛非取消异常（违约流）→ failed", async () => {
    const throwing = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
      yield { type: "text-delta", text: "partial" };
      throw new Error("adapter blew up");
    })();
    expect(await run(throwing)).toEqual({ ok: false, reason: "failed" });
  });

  it("看门狗：流静默挂死 → aborted 跳过本轮不悬挂（挂起面收口）", async () => {
    const outcome = await run(hangScript("partial"), { idleTimeoutMs: 30 });
    expect(outcome).toEqual({ ok: false, reason: "aborted" });
  });

  it("拨号形状：system 提示词先行 + 单 user 提示 + 空 tools/maxTokens", async () => {
    const fake = fakeLlm();
    fake.scripts.push(textScript("ok"));
    await summarize({
      llm: fake.runtime,
      face: { model: "sum", provider: "p2", contextWindow: 100_000, maxOutputTokens: 777 },
      reserveTokens: 10_000,
      conversation: "c",
      signal,
      idleTimeoutMs: 0,
    });
    const call = fake.calls[0];
    expect(call?.model).toBe("sum");
    expect(call?.provider).toBe("p2");
    expect(call?.tools).toEqual([]);
    expect(call?.maxTokens).toBe(777);
    expect(call?.messages[0]).toMatchObject({ role: "system" });
    expect(call?.messages[1]?.role).toBe("user");
    expect((call?.messages[0] as { text?: string } | undefined)?.text).toContain("summarization assistant");
  });
});
