// L1 清理（对照参照系 scavenger.test 语义；落账面改写为 tool/result 单点 replace）。

import { describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { computeClearPlan, gainTokensOf, landClearPlan, lastTurnStartIndex, PLACEHOLDER_PREFIX } from "../scavenger.ts";
import { logEvent, textOf, toolResultNode, userNode } from "./helpers.ts";

function toolUseAssistantNode(seq: number, call: { readonly callId: string; readonly name: string; readonly args: string }): SurfaceNode {
  return {
    seq,
    event: logEvent("assistant/message", seq, {
      turn: 0,
      step: 0,
      content: [{ type: "tool_use", callId: call.callId, name: call.name, input: call.args }],
      stopReason: "stop",
    }) as never,
  } as never;
}

/** [u0 a1(use c1) t2 u3 a4(use c2) t5 u6]：两轮工具 + 在飞轮 u6 */
function fixture(): { nodes: SurfaceNode[]; events: ReturnType<typeof logEvent>[] } {
  const nodes = [
    userNode(0, "turn-0"),
    toolUseAssistantNode(1, { callId: "c1", name: "read", args: JSON.stringify({ path: "/a.ts" }) }),
    toolResultNode(2, "c1", textOf(10)),
    userNode(3, "turn-1"),
    toolUseAssistantNode(4, { callId: "c2", name: "grep", args: JSON.stringify({ path: "/b.ts" }) }),
    toolResultNode(5, "c2", textOf(20)),
    userNode(6, "turn-2"),
  ];
  const events = [
    logEvent("tool/call", 1, { turn: 0, step: 0, callId: "c1", name: "read", arguments: JSON.stringify({ path: "/a.ts" }) }),
    logEvent("tool/call", 2, { turn: 0, step: 0, callId: "c2", name: "grep", arguments: JSON.stringify({ path: "/b.ts" }) }),
  ];
  return { nodes, events };
}

const CONFIG = { clearableTools: ["read", "grep", "bash"], clearKeepRecent: 0 };

describe("computeClearPlan", () => {
  it("白名单命中 + 在飞轮整轮豁免（最后真轮起点之后的 tool/result 不进计划）", () => {
    const { nodes, events } = fixture();
    expect(lastTurnStartIndex(nodes)).toBe(6);
    const plan = computeClearPlan(nodes, events, CONFIG);
    expect(plan.entries.map((entry) => entry.callId).sort()).toEqual(["c1", "c2"]);
    // 白名单外豁免
    const writeFixture = {
      nodes: [userNode(0, "t"), toolUseAssistantNode(1, { callId: "w", name: "write", args: JSON.stringify({ path: "/w.ts" }) }), toolResultNode(2, "w", textOf(10)), userNode(3, "next")],
      events: [logEvent("tool/call", 1, { turn: 0, step: 0, callId: "w", name: "write", arguments: JSON.stringify({ path: "/w.ts" }) })],
    };
    expect(computeClearPlan(writeFixture.nodes, writeFixture.events, CONFIG).entries).toEqual([]);
  });

  it("keepRecent 最新豁免：自尾向首保底 N 条", () => {
    const { nodes, events } = fixture();
    const plan = computeClearPlan(nodes, events, { ...CONFIG, clearKeepRecent: 1 });
    expect(plan.entries.map((entry) => entry.callId)).toEqual(["c1"]); // 最新（尾部）的 c2 被豁免
  });

  it("占位幂等：已清理结果以 PLACEHOLDER_PREFIX 前缀识别跳过（二次计划为空）", () => {
    fixture();
    const cleared = [userNode(0, "t"), toolUseAssistantNode(1, { callId: "c1", name: "read", args: "{}" }), toolResultNode(2, "c1", `${PLACEHOLDER_PREFIX} read /a.ts 40 chars]`), userNode(3, "next")];
    const clearedEvents = [logEvent("tool/call", 1, { turn: 0, step: 0, callId: "c1", name: "read", arguments: "{}" })];
    expect(computeClearPlan(cleared, clearedEvents, CONFIG).entries).toEqual([]);
  });

  it("path 提取：read/grep 取参数 path；bash 取命令首 token + cwd；无 path → <no-path>", () => {
    const cases: Array<{ name: string; args: string; expected: string }> = [
      { name: "read", args: JSON.stringify({ path: "/x.ts" }), expected: "/x.ts" },
      { name: "bash", args: JSON.stringify({ command: "ls -la /tmp", cwd: "/repo" }), expected: "ls (/repo)" },
      { name: "bash", args: JSON.stringify({ command: "" }), expected: "<no-path>" },
      { name: "read", args: "not-json", expected: "<no-path>" },
    ];
    for (const { name, args, expected } of cases) {
      const nodes = [userNode(0, "t"), toolUseAssistantNode(1, { callId: "c", name, args }), toolResultNode(2, "c", "x"), userNode(3, "n")];
      const events = [logEvent("tool/call", 1, { turn: 0, step: 0, callId: "c", name, arguments: args })];
      const plan = computeClearPlan(nodes, events, { clearableTools: [name], clearKeepRecent: 0 });
      expect(plan.entries[0]?.placeholder).toContain(expected);
    }
  });

  it("单轮会话无候选（唯一真轮起点必须保留——lastStart=0）", () => {
    const nodes = [userNode(0, "only"), toolResultNode(1, "c", "x")];
    expect(computeClearPlan(nodes, [], CONFIG).entries).toEqual([]);
    expect(gainTokensOf([])).toBe(0);
  });
});

describe("landClearPlan（装配层落账）", () => {
  it("逐条 replace 落账：占位文案替换内容、callId/turn/step/isError 保留、配对不破坏", async () => {
    const { makeWorld, seedToolTurn, sid } = await import("./helpers.ts");
    const world = await makeWorld();
    try {
      const made = await world.store.create({ id: sid("l1") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      seedToolTurn(session, { turn: 0, user: "go", tool: "read", callId: "c1", args: JSON.stringify({ path: "/a.ts" }), result: textOf(50) });
      seedToolTurn(session, { turn: 1, user: "next", tool: "read", callId: "c2", args: JSON.stringify({ path: "/b.ts" }), result: "err", usage: { input: 100, output: 1 } });
      const plan = computeClearPlan(session.surface(), session.events(), { clearableTools: ["read"], clearKeepRecent: 0 });
      expect(plan.entries).toHaveLength(1); // 在飞轮（turn-1）整轮豁免
      const landed = landClearPlan(session, session.surface(), plan.entries);
      expect(landed.landed).toBe(1);
      const cleared = session.surface().find((node) => node.event.type === "tool/result");
      const data = cleared?.event.data as { callId: string; content: string };
      expect(data.callId).toBe("c1");
      expect(data.content.startsWith(PLACEHOLDER_PREFIX)).toBe(true);
      expect(data.content).toContain("/a.ts");
      expect(session.deriveMessages().some((message) => message.role === "tool" && message.callId === "c1")).toBe(true); // 配对仍在
      // 幂等：二次计划为空
      expect(computeClearPlan(session.surface(), session.events(), { clearableTools: ["read"], clearKeepRecent: 0 }).entries).toEqual([]);
    } finally {
      await world.ctx.dispose();
    }
  });
});
