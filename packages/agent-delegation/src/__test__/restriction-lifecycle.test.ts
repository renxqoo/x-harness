// W2A：restriction 生命周期（ELEVATION-MIGRATION-W2A §5 泄漏回归——自 delegation.test.ts
// 拆出，件15 批2 行数上限处置；主题独立成文件）。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { makeWorld, spawnParent, callTool, makeOptions, sessionOf } from "./world.ts";

describe("restriction 生命周期（W2A）", () => {
  it("子代理终结（dispose → sessionDisposed）自动注销其会话层 restriction——无泄漏", async () => {
    const world = await makeWorld(await makeOptions({ narrow: { tools: ["allowed_tool"] } }));
    world.registry.register({ name: "allowed_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    const parent = await spawnParent(world);
    const child = await callTool({ world, name: "agent_spawn", args: { description: "c", prompt: "c", subagent_type: "narrow" }, session: parent.agent.session.id });
    const childSession = sessionOf(child.content);
    expect(world.registry.restrictionOf(childSession)).toEqual(["allowed_tool"]); // 在场
    const childHandle = world.loop.get(childSession);
    if (childHandle !== undefined) await childHandle.dispose();
    expect(world.registry.restrictionOf(childSession)).toBeUndefined(); // 终结即注销
    await parent.dispose();
  });
});
