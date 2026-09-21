// 边沿注入快照原语（docs/TAIL-SNAPSHOT-CHANNEL.md）：幂等表驱动（在场跳过/缺席注入/
// 内容变化重注入/render 异常/空串零注入）+ isSnapshotNode 四重谓词 + 同步点断言形态
// （同步触发返回后立即断言——引入 await 的实现必红）。

import { beforeEach, describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { SNAPSHOT_SUPERSEDES, createTailSnapshot, isSnapshotNode, snapshotEnvelope } from "../snapshot.ts";
import { makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

/** user/message 全部 text 块原文（循环版——避免嵌套回调超限） */
function textsOf(agent: { session: { events: () => readonly unknown[] } }): string[] {
  const out: string[] = [];
  for (const raw of agent.session.events()) {
    const event = raw as { type: string; data: unknown };
    if (event.type !== "user/message") continue;
    const content = (event.data as unknown as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    for (const block of content) {
      if (block.type === "text" && block.text !== undefined) out.push(block.text);
    }
  }
  return out;
}

const nodeOf = (text: string, op: "append" | { op: "replace"; startSeq: number; endSeq: number } = "append"): SurfaceNode =>
  ({ seq: 1, event: { type: "user/message", seq: 1, time: 1, data: { turn: 0, step: 0, content: [{ type: "text", text }] }, surfaceOp: op } }) as unknown as SurfaceNode;

describe("isSnapshotNode 四重谓词（append ∧ user/message ∧ 单 text 块 ∧ 信封首行+作废次行）", () => {
  it("合法快照 → true；四重缺一皆 false", () => {
    expect(isSnapshotNode(nodeOf(snapshotEnvelope("date", "Today's date: 2026-09-21")))).toBe(true);
    expect(isSnapshotNode(nodeOf("普通用户消息"))).toBe(false); // 无信封首行
    expect(isSnapshotNode(nodeOf(snapshotEnvelope("date", "x"), { op: "replace", startSeq: 0, endSeq: 0 }))).toBe(false); // replace op
    expect(isSnapshotNode(nodeOf(`<snapshot kind="date">\n别的次行\nbody\n</snapshot>`))).toBe(false); // 无作废声明次行
    const two = { seq: 1, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: snapshotEnvelope("date", "x") }, { type: "text", text: "extra" }] } } } as unknown as SurfaceNode;
    expect(isSnapshotNode(two)).toBe(false); // 双块
  });

  it("snapshotEnvelope 铸形：首行标签 + 次行作废声明 + body + 闭合", () => {
    const text = snapshotEnvelope("agent-types", "body line");
    expect(text).toBe(`<snapshot kind="agent-types">\n${SNAPSHOT_SUPERSEDES}\nbody line\n</snapshot>`);
  });
});

describe("createTailSnapshot 幂等注入（同步点断言——docs/TAIL-SNAPSHOT-CHANNEL.md 测试口径）", () => {
  it("缺席注入 → 同 kick 在场跳过 → 内容变化重注入（旧条仍在场）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    let current = snapshotEnvelope("date", "Today's date: 2026-09-21");
    const warnings: string[] = [];
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "date", render: () => current, onWarn: (m) => warnings.push(m) } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"), textScript("b"));
    agent.followup("first");
    // 同步点断言：followup 返回时快照已落 surface（kick 首行 emitStatus 同步扇出）
    expect(textsOf(agent)).toEqual([current]);
    await agent.whenIdle();
    agent.followup("second"); // 同文本第二次 kick
    await agent.whenIdle();
    expect(textsOf(agent).filter((t) => t === current)).toHaveLength(1); // 幂等：不重复注入
    current = snapshotEnvelope("date", "Today's date: 2026-09-22"); // 内容变化（跨天）
    agent.followup("third");
    await agent.whenIdle();
    expect(textsOf(agent).filter((t) => t.includes("2026-09-21"))).toHaveLength(1); // 旧条在场（历史不改写）
    expect(textsOf(agent).filter((t) => t.includes("2026-09-22"))).toHaveLength(1); // 新条注入
    expect(warnings).toEqual([]);
    off();
    await handle.dispose();
  });

  it("render 抛异常 → onWarn 一条、不 append、kick 不炸；空串零注入", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const warnings: string[] = [];
    let mode: "throw" | "empty" | "ok" = "throw";
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "x", render: () => {
      if (mode === "throw") throw new Error("boom");
      return mode === "empty" ? "" : snapshotEnvelope("x", "body");
    }, onWarn: (m) => warnings.push(m) } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"), textScript("b"));
    const snapshotTexts = (): string[] => textsOf(agent).filter((t) => t.startsWith("<snapshot"));
    agent.followup("first"); // render 抛
    await agent.whenIdle();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("snapshot(x): render failed");
    expect(textsOf(agent)).toEqual(["first"]); // 精确断言：无任何额外注入（含空 text 块垃圾注入变异）
    mode = "empty";
    agent.followup("second"); // 空串
    await agent.whenIdle();
    expect(textsOf(agent)).toEqual(["first", "second"]);
    mode = "ok";
    agent.followup("third"); // 正常
    await agent.whenIdle();
    expect(snapshotTexts()).toHaveLength(1);
    off();
    await handle.dispose();
  });

  it("预锚落位 + 本轮请求即携带（症状：快照通道在生产静默失效——deriveMessages 特判丢弃或落点漂移必红）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const envelope = snapshotEnvelope("date", "Today's date: 2026-09-21");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "date", render: () => envelope } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("ok"));
    agent.followup("hi");
    await agent.whenIdle();
    const surface = agent.session.surface();
    // 首 kick 预锚落位：快照在 system 锚点之前，本轮 user 批次在锚点之后
    expect(surface[0]?.event.type).toBe("user/message");
    const first = surface[0]?.event.data as unknown as { content: Array<{ text: string }> };
    expect(first.content[0]?.text).toBe(envelope);
    expect(surface[1]?.event.type).toBe("system/message");
    expect(surface[2]?.event.type).toBe("user/message"); // 本轮 user 批次在锚点之后
    expect(surface[3]?.event.type).toBe("assistant/message");
    // 本轮请求即携带：请求体 messages 含快照全文（端到端）
    expect(JSON.stringify(world.fake.calls[0]?.messages)).toContain("Today's date: 2026-09-21");
    off();
    await handle.dispose();
  });

  it("presence 多块负面夹具：append 型 user/message 多块中含快照全文不算在场", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const envelope = snapshotEnvelope("date", "Today's date: 2026-09-21");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "date", render: () => envelope } });
    const { agent, handle } = await spawn(world);
    const seeded = agent.session.append(
      "user/message",
      { turn: 0, step: 0, content: [{ type: "tool_use", callId: "c", name: "t", input: "{}" }, { type: "text", text: envelope }] },
      { surfaceOp: "append" },
    );
    if (!seeded.ok) throw new Error(seeded.reason);
    world.fake.scripts.push(textScript("ok"));
    agent.followup("hi");
    await agent.whenIdle();
    expect(textsOf(agent).filter((t) => t === envelope)).toHaveLength(2); // 多块不算在场 → 仍注入单块快照
    off();
    await handle.dispose();
  });

  it("在场判定收窄 append-op：replace 型摘要节点整段回显不误判在场", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const text = snapshotEnvelope("project-instructions", "instructions body");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "pi", render: () => text } });
    const { agent, handle } = await spawn(world);
    // 预置一条 replace 型摘要节点，内容 = 快照全文（/compact 整段回显形态）
    const appended = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text }] }, { surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } });
    expect(appended.ok).toBe(false); // 端点缺失——先补一个合法 append 节点再 replace
    const seed = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "seed" }] }, { surfaceOp: "append" });
    if (!seed.ok) throw new Error(seed.reason);
    const seq = agent.session.events().at(-1)?.seq;
    if (seq === undefined) throw new Error("seed node missing");
    const replaced = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text }] }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq } });
    expect(replaced.ok).toBe(true);
    world.fake.scripts.push(textScript("a"));
    agent.followup("go");
    await agent.whenIdle();
    expect(textsOf(agent).filter((t) => t === text)).toHaveLength(2); // replace 节点 1 + append 快照 1——回显不误判在场
    off();
    await handle.dispose();
  });
});
