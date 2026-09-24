// 件15 D7：summary 截断承诺兑现（docs/DELEGATION-LONG-CONTENT.md §3）——schema 去上限
// （批1）后 verb 层 SUMMARY_CAP 是唯一兑现点；echoSummary 统一出口三投递路径全覆盖。

import { describe, expect, it, vi } from "vitest";
import { makeWorld, spawnParent, callTool, textScript, CHILD_MODEL, makeOptions, agentIdOf, sessionOf } from "./world.ts";

describe("summary 回显统一出口（件15 D7）", () => {
  it("601 字符 summary 投递成功 + 回显截断到 500 + 省略号（description 承诺兑现）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }));
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const longSummary = "s".repeat(601);
    const sent = await callTool({ world, name: "agent_message", args: { to: agentIdOf(spawned.content), message: "ping", summary: longSummary }, session: parent.agent.session.id });
    expect(sent.isError).not.toBe(true); // 投递成功——元数据超长不否决真实负载
    expect(sent.content).toContain(`(summary: ${"s".repeat(500)}…)`);
    expect(sent.content).not.toContain("s".repeat(501)); // 截断而非全文回显
    await parent.dispose();
  });

  it("summary 空串 → 无回显附注（守卫）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }));
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const sent = await callTool({ world, name: "agent_message", args: { to: agentIdOf(spawned.content), message: "ping", summary: "" }, session: parent.agent.session.id });
    expect(sent.content).not.toContain("(summary:");
    await parent.dispose();
  });

  it("main 通道回显覆盖（子→父路径）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }));
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "child done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    const turnEnds = (): number => world.loop.get(childSession)?.agent.session.events().filter((e) => e.type === "turn/end").length ?? 0;
    await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 5_000 }); // 子完成首轮转 idle
    const sent = await callTool({ world, name: "agent_message", args: { to: "main", message: "child to parent", summary: "a label" }, session: childSession });
    expect(sent.isError).not.toBe(true);
    expect(sent.content).toContain("(summary: a label)"); // main 通道（deliverToMain）回显覆盖
    await parent.dispose();
  });
});
