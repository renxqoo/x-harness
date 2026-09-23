// 报告全文单次交付口径：完成通知是报告唯一交付点——全文直送（reportCap 同一上界），
// 追问具体信息走 agent_message。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import type { World } from "./world.ts";
import { makeWorld, spawnParent, callTool, textScript, CHILD_MODEL, makeOptions, resetWorlds, agentIdOf, sessionOf } from "./world.ts";

const eventsOf = (world: World, session: SessionId): readonly ReturnType<Session["events"]>[number][] => {
  const found = world.ctx.use(sessionStore).get(session);
  return found === undefined ? [] : found.events();
};

const childEnded = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "turn/end");

beforeEach(() => {
  resetWorlds();
});

describe("报告全文单次交付", () => {
  it("完成通知直送全文（与 reportCap 同一上界，不截断引导指向读动词）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } })); // 缺省 reportCap 34000
    const parent = await spawnParent(world);
    const long = "y".repeat(300);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, long)]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    void agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const lastNotice = (): string => JSON.stringify(parent.agent.session.events().filter((e) => e.type === "agent/message").at(-1)?.data);
    await vi.waitFor(() => expect(lastNotice()).toContain(`summary: ${long}`), { timeout: 5_000 }); // 通知即全文
    expect(lastNotice()).not.toContain("truncated at"); // 300 < reportCap——全文无截断
    await parent.dispose();
  });

  it("超 reportCap 通知截断 + agent_message 追问引导（无读动词引导）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { reportCap: 100 }));
    const parent = await spawnParent(world);
    const long = "z".repeat(300);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, long)]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    void agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const lastNotice = (): string => JSON.stringify(parent.agent.session.events().filter((e) => e.type === "agent/message").at(-1)?.data);
    await vi.waitFor(() => expect(lastNotice()).toContain("truncated at 100"), { timeout: 5_000 });
    expect(lastNotice()).toContain("use agent_message to ask the agent for specifics"); // 追问走对话，非读动词
    await parent.dispose();
  });
});
