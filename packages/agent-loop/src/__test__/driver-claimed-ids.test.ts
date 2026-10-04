import { describe, expect, it } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import type { Session } from "@x-harness/session";
import { agentTurnStopping } from "../index.ts";
import { makeWorld, spawn, worlds } from "./world.ts";

function lastQueuedTurnEntryId(session: Session): string {
  const inserts = session
    .events()
    .filter((e) => e.type === "agent/inbox/spliced" && (e.data as { op?: string }).op === "insert" && (e.data as { target?: string }).target === "next-turn");
  const last = inserts.at(-1)?.data as { entries: Array<{ id: string }> } | undefined;
  return last?.entries[0]?.id ?? "";
}

describe("认领物化 claimedIds（回显身份协议）", () => {
  it("认领物化携带 claimedIds（user 标记条目按序登记；立即改向的较新条目先物化）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: "first" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    );
    let retargeted = false;
    const off = world.ctx.on(agentTurnStopping, () => {
      if (retargeted) return;
      retargeted = true;
      const entryId = lastQueuedTurnEntryId(agent.session);
      expect(entryId).toBeTruthy();
      agent.session.append("agent/inbox/spliced", { op: "retarget", id: entryId, to: "next-step" });
    });
    agent.followup("first message");
    agent.followup("second message");
    await agent.whenIdle();
    off();
    // 物化帧（可多帧）合并携带两条 user 输入的 inbox id；内部注入（无）不占名额
    const userFrames = agent.session.events().filter((e) => e.type === "user/message" && e.surfaceOp === "append");
    const claimed = userFrames.flatMap((e) => (e.data as { claimedIds?: string[] }).claimedIds ?? []);
    const userEntriesOf = (entries: Array<{ id: string; user?: true }>): string[] => entries.filter((entry) => entry.user === true).map((entry) => entry.id);
    const insertedUserIds = agent.session
      .events()
      .filter((e) => e.type === "agent/inbox/spliced" && (e.data as { op?: string }).op === "insert")
      .flatMap((e) => userEntriesOf((e.data as { entries?: Array<{ id: string; user?: true }> }).entries ?? []));
    expect(insertedUserIds).toHaveLength(2);
    expect([...claimed].sort()).toEqual([...insertedUserIds].sort());
    await handle.dispose();
  });

});
