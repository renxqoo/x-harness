// token 格式化（docs/CLI.md §2.3/§4 表驱动）：阶梯换算 + turn 行/session 摘要组装。

import { describe, expect, it } from "vitest";
import { formatSessionSummary, formatTokens, formatTurnLine } from "../format-usage.ts";
import type { SessionUsage } from "@x-harness/token-meter";

describe("formatTokens（表驱动）", () => {
  const cases: readonly { readonly input: number; readonly expected: string }[] = [
    { input: 0, expected: "0" },
    { input: 7, expected: "7" },
    { input: 999, expected: "999" },
    { input: 1_000, expected: "1k" },
    { input: 9_900, expected: "9.9k" },
    { input: 12_340, expected: "12.3k" },
    { input: 123_000, expected: "123k" },
    { input: 1_200_000, expected: "1.2M" },
    { input: 250_000_000, expected: "250M" },
  ];
  for (const testCase of cases) {
    it(`${String(testCase.input)} → ${testCase.expected}`, () => {
      expect(formatTokens(testCase.input)).toBe(testCase.expected);
    });
  }
});

function usage(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    inputTokens: 1200,
    outputTokens: 3400,
    totalTokens: 4600,
    attempts: 1,
    turns: [{ turn: 1, inputTokens: 1200, outputTokens: 3400, routes: [{ provider: "glm", model: "glm-4.7", inputTokens: 1200, outputTokens: 3400 }] }],
    ...over,
  };
}

describe("formatTurnLine", () => {
  it("含 turn 序号、双向用量、总量与末次路线归因", () => {
    expect(formatTurnLine(3, usage())).toBe("[turn 3] ↑1.2k ↓3.4k · 4.6k (glm/glm-4.7)");
  });

  it("无路线记录（unknown）省略括号段", () => {
    const bare = usage({ turns: [{ turn: 1, inputTokens: 1200, outputTokens: 3400, routes: [] }] });
    expect(formatTurnLine(1, bare)).toBe("[turn 1] ↑1.2k ↓3.4k · 4.6k");
  });
});

describe("formatSessionSummary", () => {
  it("/session 摘要含 attempts 与 turns 计数", () => {
    const line = formatSessionSummary(usage({ attempts: 4 }));
    expect(line).toBe("tokens: ↑1.2k ↓3.4k · 4.6k · attempts 4 · turns 1");
  });
});
