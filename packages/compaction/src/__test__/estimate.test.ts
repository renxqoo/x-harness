// 估算的消息面（docs/COMPACTION.md §1.4；对照参照系 pure-estimate 语义子集：承接
// 块角色全覆盖；image 固定估值见文末 describe——视觉下采样典型占用，不按字节估；
// 字符串口径归 token-meter 表驱动，不在此重复）。

import { describe, expect, it } from "vitest";
import { estimateBlocks, estimateMessage, IMAGE_TOKENS, nodeTokens } from "../estimate.ts";
import type { ContentBlock, SurfaceMessage } from "@x-harness/session";
import { assistantNode, systemNode, textOf, toolResultNode, userNode } from "./helpers.ts";

describe("estimateMessage / estimateBlocks / nodeTokens", () => {
  it("四角色全覆盖：system 文本、user/assistant 块、tool 结果串", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: textOf(3) },
      { type: "tool_use", callId: "c", name: "read", input: JSON.stringify({ path: "/a.ts" }) }, // name+input 求和
    ];
    expect(estimateBlocks([{ type: "text", text: textOf(2) }])).toBe(2);
    expect(estimateBlocks(blocks)).toBeGreaterThan(3); // tool_use 计入
    const messages: SurfaceMessage[] = [
      { role: "system", text: textOf(4) },
      { role: "user", content: [{ type: "text", text: textOf(5) }] },
      { role: "assistant", content: [{ type: "text", text: textOf(6) }] },
      { role: "tool", callId: "c", content: textOf(7) },
    ];
    expect(estimateMessage(messages[0] as never)).toBe(4);
    expect(estimateMessage(messages[1] as never)).toBe(5);
    expect(estimateMessage(messages[2] as never)).toBe(6);
    expect(estimateMessage(messages[3] as never)).toBe(7);
  });

  it("nodeTokens 与 estimateMessage 同口径（直接读事件 data）", () => {
    expect(nodeTokens(systemNode(0, textOf(2)))).toBe(2);
    expect(nodeTokens(userNode(1, textOf(3)))).toBe(3);
    expect(nodeTokens(assistantNode(2, textOf(4)))).toBe(4);
    expect(nodeTokens(toolResultNode(3, "c", textOf(5)))).toBe(5);
  });

  it("CJK 上界不低估（chars/4 旧口径为反例——token-meter 单一真相承接）", () => {
    const cjk = "你好世界"; // 4 字 × 1.25 = 5
    expect(estimateMessage({ role: "user", content: [{ type: "text", text: cjk }] })).toBe(5);
  });
});

describe("image 块估算（BATCH2-DESIGN §1.2——视觉下采样典型占用，不按 base64 字节估）", () => {
  it("image 块计固定 IMAGE_TOKENS（高估促折叠，安全侧）", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "image", data: "x".repeat(4096), mediaType: "image/png" },
    ];
    expect(estimateBlocks(blocks)).toBe(estimateBlocks([{ type: "text", text: "hi" }]) + IMAGE_TOKENS);
  });
});
