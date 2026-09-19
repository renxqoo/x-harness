// blockPresent 分支直测（docs/SKILL.md §1.3）：不假设 content[0]——空 content、
// tool_use 首块、system 节点均不误判。

import { describe, expect, it } from "vitest";
import type { Session } from "@x-harness/session";
import { blockPresent } from "../present.ts";

const surfaceOf = (nodes: unknown[]): { surface: () => unknown[] } => ({ surface: () => nodes });

function userMessage(content: unknown[]): unknown {
  return { event: { type: "user/message", data: { turn: 0, step: 0, content } } };
}

const BLOCK = "<system-reminder>\nskills\n</system-reminder>";

describe("blockPresent", () => {
  it("匹配的 text 块在场 → true", () => {
    expect(blockPresent(surfaceOf([userMessage([{ type: "text", text: BLOCK }])]) as unknown as Session, BLOCK)).toBe(true);
  });

  it("不匹配 → false", () => {
    expect(blockPresent(surfaceOf([userMessage([{ type: "text", text: "other" }])]) as unknown as Session, BLOCK)).toBe(false);
  });

  it("空 content / 非 user 节点不误判", () => {
    const session = surfaceOf([
      { event: { type: "system/message", data: { turn: 0, step: 0, text: BLOCK } } },
      userMessage([]),
      { event: { type: "tool/result", data: { callId: "c", content: [] } } },
    ]) as unknown as Session;
    expect(blockPresent(session, BLOCK)).toBe(false);
  });

  it("不假设 content[0]：tool_use 首块后跟匹配 text 块 → true", () => {
    const session = surfaceOf([
      userMessage([{ type: "tool_use", callId: "c", name: "n", input: "{}" }, { type: "text", text: BLOCK }]),
    ]) as unknown as Session;
    expect(blockPresent(session, BLOCK)).toBe(true);
  });
});
