// 等待协议读面（反轮询执法）：spawn 返回文案与 list_agents 结果是主代理「刚委派/想查进度」
// 时必读的两个面——两处都写明「结束 turn 等通知，禁 sleep/list_agents 自旋」。
// 症状：主代理无其他任务时用 sleep 115s 自旋等子代理，每拍全量 input 过一遍且延迟粒度 115s。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, agentIdOf } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

describe("等待协议读面（反轮询执法）", () => {
  it("spawn 返回文案：结束 turn 等通知 + 禁轮询（症状：主代理 sleep 自旋等子代理）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    expect(agentIdOf(spawned.content)).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(spawned.content).toContain("End your turn to wait for it"); // 唤醒/步边界注入两种交付路径都说清
    expect(spawned.content).toContain("wakes you if idle");
    expect(spawned.content).toContain("do NOT poll"); // sleep 循环与重复 list_agents 双禁
    await parent.dispose();
  });

  it("list_agents running 行在场 → 尾附等待提示；全 settled 时零提示", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 1 }));
    const parent = await spawnParent(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "text-delta", text: "child done" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p1")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "gated", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    await vi.waitFor(async () => {
      const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
      expect(listed.content).toContain("status=running");
      expect(listed.content).toContain("end your turn and wait for the [agent-notification]"); // running 态带劝阻
    }, { timeout: 5_000 });
    release();
    await vi.waitFor(async () => {
      const settled = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
      expect(settled.content).toContain("status=idle");
      expect(settled.content).not.toContain("do not poll"); // 无 running 行零提示（idle/stopped 行不触发）
    }, { timeout: 5_000 });
    await parent.dispose();
  });
});
