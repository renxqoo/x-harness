import { beforeEach, describe, expect, it } from "vitest";
import type { SurfaceNode } from "@x-harness/session";
import { SNAPSHOT_SOURCE, SNAPSHOT_SUPERSEDES, createRequestSnapshot, createTailSnapshot, isEnvelopeSnapshotNode, snapshotEnvelope } from "../snapshot.ts";
import { agentRequest } from "../tokens.ts";
import type { Dial } from "../tokens.ts";
import { makeWorld, resetWorlds, spawn, textScript, worlds } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

interface SessionLike {
  readonly session: { events: () => readonly unknown[] };
}

function contentTexts(event: { data: unknown }): string[] {
  const content = (event.data as unknown as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []));
}

/** 真实用户输入文本（user/message 是用户输入的唯一物化形态）。 */
function userTextsOf(agent: SessionLike): string[] {
  const out: string[] = [];
  for (const raw of agent.session.events()) {
    const event = raw as { type: string; data: unknown };
    if (event.type !== "user/message") continue;
    out.push(...contentTexts(event));
  }
  return out;
}

/** 注入快照文本（agent/message ∧ source=SNAPSHOT_SOURCE）。 */
function snapshotTextsOf(agent: SessionLike): string[] {
  const out: string[] = [];
  for (const raw of agent.session.events()) {
    const event = raw as { type: string; data: unknown };
    if (event.type !== "agent/message") continue;
    if ((event.data as { source?: string }).source !== SNAPSHOT_SOURCE) continue;
    out.push(...contentTexts(event));
  }
  return out;
}

const nodeOf = (text: string, op: "append" | { op: "replace"; startSeq: number; endSeq: number } = "append"): SurfaceNode =>
  ({ seq: 1, event: { type: "user/message", seq: 1, time: 1, data: { turn: 0, step: 0, content: [{ type: "text", text }] }, surfaceOp: op } }) as unknown as SurfaceNode;

describe("isEnvelopeSnapshotNode 四重谓词（append ∧ user/message ∧ 单 text 块 ∧ 信封首行+作废次行）", () => {
  it("合法快照 → true；四重缺一皆 false", () => {
    expect(isEnvelopeSnapshotNode(nodeOf(snapshotEnvelope("date", "Today's date: 2026-09-21")))).toBe(true);
    expect(isEnvelopeSnapshotNode(nodeOf("普通用户消息"))).toBe(false);
    expect(isEnvelopeSnapshotNode(nodeOf(snapshotEnvelope("date", "x"), { op: "replace", startSeq: 0, endSeq: 0 }))).toBe(false);
    expect(isEnvelopeSnapshotNode(nodeOf(`<snapshot kind="date">\n别的次行\nbody\n</snapshot>`))).toBe(false);
    const two = { seq: 1, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: snapshotEnvelope("date", "x") }, { type: "text", text: "extra" }] } } } as unknown as SurfaceNode;
    expect(isEnvelopeSnapshotNode(two)).toBe(false);
  });

  it("snapshotEnvelope 铸形：首行标签 + 次行作废声明 + body + 闭合", () => {
    const text = snapshotEnvelope("agent-types", "body line");
    expect(text).toBe(`<snapshot kind="agent-types">\n${SNAPSHOT_SUPERSEDES}\nbody line\n</snapshot>`);
  });
});

describe("注入身份：快照落 agent/message(context-snapshot)，用户输入独占 user/message", () => {
  it("症状回归「发一条消息显示两条相同气泡」：注入快照不是 user/message，用户气泡身份无外来帧可争", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const envelope = snapshotEnvelope("date", "Today's date: 2026-09-21");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "date", render: () => envelope } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"));
    agent.followup("用户真话");
    await agent.whenIdle();
    expect(userTextsOf(agent)).toEqual(["用户真话"]);
    expect(snapshotTextsOf(agent)).toEqual([envelope]);
    const injected = agent.session.events().find((event) => event.type === "agent/message");
    expect(injected?.data).toMatchObject({ source: SNAPSHOT_SOURCE, kind: "content" });
    off();
    await handle.dispose();
  });

  it("信封形态历史落盘仍被识别（读旧会话：标题派生/切点对齐用），且不冒充新写入身份", () => {
    const legacy = nodeOf(snapshotEnvelope("date", "Today's date: 2026-09-21"));
    const typed = { seq: 1, event: { type: "agent/message", seq: 1, time: 1, data: { turn: 0, step: 0, source: SNAPSHOT_SOURCE, kind: "content", content: [{ type: "text", text: "x" }] }, surfaceOp: "append" } } as unknown as SurfaceNode;
    expect(isEnvelopeSnapshotNode(legacy)).toBe(true);
    expect(isEnvelopeSnapshotNode(typed)).toBe(false);
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
    expect(snapshotTextsOf(agent)).toEqual([current]);
    await agent.whenIdle();
    agent.followup("second");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent).filter((t) => t === current)).toHaveLength(1);
    current = snapshotEnvelope("date", "Today's date: 2026-09-22");
    agent.followup("third");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent).filter((t) => t.includes("2026-09-21"))).toHaveLength(1);
    expect(snapshotTextsOf(agent).filter((t) => t.includes("2026-09-22"))).toHaveLength(1);
    expect(warnings).toEqual([]);
    off();
    await handle.dispose();
  });

  it("信封形态历史快照在场：同文本不重注入（跨形态幂等）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const envelope = snapshotEnvelope("date", "Today's date: 2026-09-21");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "date", render: () => envelope } });
    const { agent, handle } = await spawn(world);
    const seeded = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: envelope }] }, { surfaceOp: "append" });
    if (!seeded.ok) throw new Error(seeded.reason);
    world.fake.scripts.push(textScript("a"));
    agent.followup("go");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent)).toEqual([]);
    expect(userTextsOf(agent).filter((t) => t === envelope)).toHaveLength(1);
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
    agent.followup("first");
    await agent.whenIdle();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("snapshot(x): render failed");
    expect(userTextsOf(agent)).toEqual(["first"]);
    expect(snapshotTextsOf(agent)).toEqual([]);
    mode = "empty";
    agent.followup("second");
    await agent.whenIdle();
    expect(userTextsOf(agent)).toEqual(["first", "second"]);
    mode = "ok";
    agent.followup("third");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent)).toHaveLength(1);
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
    expect(surface[0]?.event.type).toBe("agent/message");
    const first = surface[0]?.event.data as unknown as { content: Array<{ text: string }> };
    expect(first.content[0]?.text).toBe(envelope);
    expect(surface[1]?.event.type).toBe("system/message");
    expect(surface[2]?.event.type).toBe("user/message");
    expect(surface[3]?.event.type).toBe("assistant/message");
    const messages = agent.session.deriveMessages();
    expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: envelope }] });
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
    expect(snapshotTextsOf(agent)).toEqual([envelope]);
    off();
    await handle.dispose();
  });

  it("在场判定收窄 append-op：replace 型摘要节点整段回显不误判在场", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const text = snapshotEnvelope("project-instructions", "instructions body");
    const off = createTailSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "pi", render: () => text } });
    const { agent, handle } = await spawn(world);
    const appended = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text }] }, { surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } });
    expect(appended.ok).toBe(false);
    const seed = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "seed" }] }, { surfaceOp: "append" });
    if (!seed.ok) throw new Error(seed.reason);
    const seq = agent.session.events().at(-1)?.seq;
    if (seq === undefined) throw new Error("seed node missing");
    const replaced = agent.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text }] }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq } });
    expect(replaced.ok).toBe(true);
    world.fake.scripts.push(textScript("a"));
    agent.followup("go");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent)).toEqual([text]);
    off();
    await handle.dispose();
  });
});

describe("createRequestSnapshot 请求时点注入（agentRequest 派发内——render 收当次 dial）", () => {
  it("当次请求即携带 + dial 原样透传 + 每 dial 幂等", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const seen: string[] = [];
    const off = createRequestSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "model", render: (dial) => {
      seen.push(dial.model);
      return snapshotEnvelope("model", `You are powered by the model ${dial.model}.`);
    } } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"), textScript("b"));
    agent.followup("first");
    await agent.whenIdle();
    expect(JSON.stringify(world.fake.calls[0]?.messages)).toContain("You are powered by the model fake-model.");
    expect(world.fake.calls[0]?.model).toBe("fake-model");
    agent.followup("second");
    await agent.whenIdle();
    expect(seen).toEqual(["fake-model", "fake-model"]);
    expect(snapshotTextsOf(agent)).toHaveLength(1);
    off();
    await handle.dispose();
  });

  it("render 抛异常 → onWarn 一条、不 append、请求照常；空串零注入", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const warnings: string[] = [];
    let mode: "throw" | "empty" | "ok" = "throw";
    const off = createRequestSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "x", render: () => {
      if (mode === "throw") throw new Error("boom");
      return mode === "empty" ? "" : snapshotEnvelope("x", "body");
    }, onWarn: (m) => warnings.push(m) } });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"), textScript("b"), textScript("c"));
    agent.followup("first");
    await agent.whenIdle();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("snapshot(x): render failed");
    expect(JSON.stringify(world.fake.calls[0]?.messages)).not.toContain("<snapshot");
    mode = "empty";
    agent.followup("second");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent)).toHaveLength(0);
    mode = "ok";
    agent.followup("third");
    await agent.whenIdle();
    expect(snapshotTextsOf(agent)).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    off();
    await handle.dispose();
  });

  it("render 收生效 dial（下游末端改写——hub dial-hook 形态）+ 回摆重注入（对抗审查 B1/M1）", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const seen: string[] = [];
    const offSnap = createRequestSnapshot({ ctx: world.ctx, loop: world.loop, spec: { id: "model", render: (dial) => {
      seen.push(dial.model);
      return snapshotEnvelope("model", `You are powered by the model ${dial.model}.`);
    } } });
    let n = 0;
    const models = ["m-a", "m-b", "m-a"];
    const offRewrite = world.ctx.on(agentRequest, async (payload, next): Promise<Dial | undefined> => {
      const out = await next(payload);
      return out === undefined ? out : { ...out, model: models[n++] ?? "m-a" };
    });
    const { agent, handle } = await spawn(world);
    world.fake.scripts.push(textScript("a"), textScript("b"), textScript("c"));
    agent.followup("first");
    await agent.whenIdle();
    expect(seen).toEqual(["m-a"]);
    expect(JSON.stringify(world.fake.calls[0]?.messages)).toContain("the model m-a.");
    expect(world.fake.calls[0]?.model).toBe("m-a");
    agent.followup("second");
    await agent.whenIdle();
    expect(seen).toEqual(["m-a", "m-b"]);
    agent.followup("third");
    await agent.whenIdle();
    expect(seen).toEqual(["m-a", "m-b", "m-a"]);
    const snaps = snapshotTextsOf(agent).map((t) => (t.includes("m-a") ? "m-a" : "m-b"));
    expect(snaps).toEqual(["m-a", "m-b", "m-a"]);
    expect(JSON.stringify(world.fake.calls[2]?.messages)).toContain("the model m-a.");
    offRewrite();
    offSnap();
    await handle.dispose();
  });
});
