// agentLoop 服务单元（docs/AGENT-LOOP-DRIVER §1.1）：resume 修复链（archive 读→closers→seed）、
// resume 不自动 kick、无 archive fail-closed、inject 不唤醒。

import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { llmPlugin } from "@x-harness/llm";
import { sessionArchive, sessionPlugin } from "@x-harness/session";
import type { SessionEvent, SessionId, SessionSnapshot } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { afterEach, describe, expect, it } from "vitest";
import { agentLoopPlugin, agentLoopServiceToken } from "../index.ts";
import type { Agent } from "../index.ts";

interface World {
  ctx: Context;
  cleanup: () => Promise<void>;
}

async function makeWorld(withArchive?: (snapshots: Map<string, SessionSnapshot>) => void): Promise<World> {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [sessionPlugin, toolsPlugin, llmPlugin, systemPromptPlugin, agentLoopPlugin]);
  if (withArchive === undefined) {
    return { ctx, cleanup: async () => { await ctx.dispose(); void unload; } };
  }
  const snapshots = new Map<string, SessionSnapshot>();
  withArchive(snapshots);
  ctx.provide(sessionArchive, {
    list: () => [...snapshots.keys()] as SessionId[],
    read: async (id) => {
      const snapshot = snapshots.get(id);
      return snapshot === undefined ? { ok: false, reason: `no-session:${id}` } : { ok: true, value: snapshot };
    },
    listHeaders: async () => [...snapshots.values()].map((snapshot) => snapshot.header),
  });
  return { ctx, cleanup: async () => { await ctx.dispose(); void unload; } };
}

let worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds) await world.cleanup().catch(() => {});
  worlds = [];
});

const AGENT = { model: "fake-model", provider: "fake" };

describe("agentLoop 服务（docs/AGENT-LOOP-DRIVER §1.1）", () => {
  it("无 sessionArchive → resume fail-closed", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const loop = world.ctx.use(agentLoopServiceToken);
    const resumed = await loop.resume({ id: "nope" as SessionId });
    expect(resumed).toEqual({ ok: false, reason: "no-session-archive" });
  });

  it("archive 读失败透传 reason", async () => {
    const world = await makeWorld((snapshots) => {
      void snapshots;
    });
    worlds.push(world);
    const loop = world.ctx.use(agentLoopServiceToken);
    const resumed = await loop.resume({ id: "missing" as SessionId });
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.reason).toContain("missing");
  });

  it("resume：悬空卷经 closers 闭合入 seed；不自动 kick（idle 且无 turn 事件）", async () => {
    const events: SessionEvent[] = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } } as SessionEvent,
      { type: "step/start", seq: 1, time: 1, data: { turn: 0, step: 0 } } as SessionEvent,
      {
        type: "assistant/message",
        seq: 2,
        time: 1,
        surfaceOp: "append",
        data: { turn: 0, step: 0, content: [{ type: "tool_use", callId: "c1", name: "t", input: "{}" }], stopReason: "stop" },
      } as SessionEvent,
    ];
    const world = await makeWorld((snapshots) => {
      snapshots.set("s1" as SessionId, { header: { id: "s1" as SessionId, createdAt: 1 }, events });
    });
    worlds.push(world);
    const loop = world.ctx.use(agentLoopServiceToken);
    const resumed = await loop.resume({ id: "s1" as SessionId, agent: AGENT });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const agent: Agent = resumed.value.agent;
    // seed = 原卷 + closers（tool/result 合成 + step/end + turn/end{interrupted} + end-seed 边界）
    const types = agent.session.events().map((e) => e.type);
    expect(types).toEqual([
      "turn/start",
      "step/start",
      "assistant/message",
      "tool/result",
      "step/end",
      "turn/end",
      "session/end-seed",
    ]);
    const synthetic = agent.session.events()[3];
    expect(synthetic?.data).toMatchObject({ callId: "c1", isError: true });
    // F19：resume 不自动 kick
    expect(agent.status).toBe("idle");
    expect(agent.session.events().some((e) => e.type === "turn/start" && e.data.turn === 1)).toBe(false);
    await resumed.value.dispose();
  });

  it("inject：落 next-step 但不唤醒（status 恒 idle，无 turn 事件）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const loop = world.ctx.use(agentLoopServiceToken);
    const made = await loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const agent = made.value.agent;
    agent.inject("background note");
    expect(agent.status).toBe("idle");
    expect(agent.session.events().filter((e) => e.type === "turn/start")).toHaveLength(0);
    const spliced = agent.session.events().filter((e) => e.type === "agent/inbox/spliced");
    expect(spliced.at(-1)?.data).toMatchObject({ op: "insert", target: "next-step" });
    await made.value.dispose();
  });
});
