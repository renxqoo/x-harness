// 类型系统快照注入（docs/AGENT-DELEGATION.md §7 + docs/TAIL-SNAPSHOT-CHANNEL.md）：
// .md 唯一来源 + 边沿注入快照（信封 + <system-reminder> 体）+ 同步装载当轮可见。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "@x-harness/session";
import { systemPrompt as systemPromptToken } from "@x-harness/system-prompt";
import type { SessionId } from "@x-harness/session";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { World } from "./world.ts";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, sessionOf } from "./world.ts";
import type { Session } from "@x-harness/session";

const eventsOf = (world: World, session: SessionId): readonly ReturnType<Session["events"]>[number][] => {
  const found = world.ctx.use(sessionStore).get(session);
  return found === undefined ? [] : found.events();
};

/** user/message 的原文本块拼接（信封断言用——JSON.stringify 会转义引号） */
const userTextsOf = (world: World, session: SessionId): string =>
  eventsOf(world, session)
    .filter((e) => e.type === "user/message")
    .flatMap((e) => ((e.data as unknown as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? ""))
    .join("\n");

const childEnded = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "turn/end");

beforeEach(() => {
  resetWorlds();
});

describe("类型系统（件13 §7：.md 唯一来源 + 快照注入——docs/TAIL-SNAPSHOT-CHANNEL.md）", () => {
  it("类型清单走边沿注入快照（<snapshot kind=agent-types> 信封 + <system-reminder> 体，含 name/description/model）；无类型零注入", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "kick")]);
    parent.agent.followup("go");
    await parent.agent.whenIdle();
    const snapshots = userTextsOf(world, parent.agent.session.id);
    expect(snapshots).toContain('<snapshot kind="agent-types">');
    expect(snapshots).toContain("This snapshot supersedes earlier snapshots of this kind.");
    expect(snapshots).toContain("Available agent types:");
    expect(snapshots).toContain("- worker — test type worker (model: child-model)");
    // 装配文本不再含类型段（锚点静态化）
    expect(world.ctx.use(systemPromptToken).assemble().text).not.toContain("Available agent types:");
    const empty = await makeWorld(await makeOptions({}));
    const bare = await spawnParent(empty);
    empty.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "kick")]);
    bare.agent.followup("go");
    await bare.agent.whenIdle();
    const bareSnapshots = userTextsOf(empty, bare.agent.session.id);
    expect(bareSnapshots).not.toContain("Available agent types:");
    await bare.dispose();
    await parent.dispose();
  });

  it("kick 边沿 mtime 探测重载（同步装载）：新 .md 文件当轮 kick 即入快照（症状：类型变更一 kick 滞后）", async () => {
    const options = await makeOptions({ worker: { model: CHILD_MODEL } });
    const world = await makeWorld(options);
    const parent = await spawnParent(world);
    const dir = (options.agentsDirs ?? [])[0] as string;
    await writeFile(join(dir, "late.md"), "---\nname: late\ndescription: added later\n---\nbody");
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "kick")]);
    parent.agent.followup("reload probe"); // kick → running 边沿 → 同步探测+渲染+注入
    await parent.agent.whenIdle();
    const snapshots = userTextsOf(world, parent.agent.session.id);
    expect(snapshots).toContain("- late — added later"); // 同 kick 当轮可见——不待第二次 kick
    await parent.dispose();
  });

  it("untyped/fork 子（未设 options.systemPrompt）同见快照——共享边沿注入事实（§7.2）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const childSnapshots = userTextsOf(world, childSession);
    expect(childSnapshots).toContain("Available agent types:");
    await parent.dispose();
  });
});


describe("锚点静态锚（TAIL-SNAPSHOT-CHANNEL——症状：易变事实变化致全前缀失效）", () => {
  it("类型增删跨 kick：system/message 事件数不增（零 replace——清单走快照不回锚点）", async () => {
    const options = await workerOptions();
    const world = await makeWorld(options);
    const parent = await spawnParent(world);
    const systemCount = (): number => parent.agent.session.events().filter((e) => e.type === "system/message").length;
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "a"), textScript(PARENT_MODEL, "b")]);
    parent.agent.followup("one");
    await parent.agent.whenIdle();
    const baseline = systemCount();
    expect(baseline).toBeGreaterThanOrEqual(1); // 首 kick 落锚
    const dir = (options.agentsDirs ?? [])[0] as string;
    const { writeFile: writeLater } = await import("node:fs/promises");
    await writeLater(join(dir, "extra.md"), "---\nname: extra\ndescription: later\n---\nbody");
    parent.agent.followup("two");
    await parent.agent.whenIdle();
    expect(userTextsOf(world, parent.agent.session.id)).toContain("- extra — later"); // 新类型经快照可见
    expect(systemCount()).toBe(baseline); // 零 replace：锚点不动
    await parent.dispose();
  });
});
