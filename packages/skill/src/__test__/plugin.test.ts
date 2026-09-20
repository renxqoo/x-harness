// plugin 装配集成（docs/SKILL.md §1.3/§7）：running 边沿无状态幂等注入——注入/幂等/
// 同步红线/折叠自愈/封存降级/零快照无痕/多会话/dispose 摘除。
// loop 以同名 stub 提供（get 返回预置 session）——装配面只消费 get。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, agentStatus } from "@x-harness/agent-loop";
import type { AgentHandle, AgentLoopService } from "@x-harness/agent-loop";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { Session, SessionId } from "@x-harness/session";
import { createSkillPlugin } from "../plugin.ts";
import { loadSkills } from "../loader.ts";
import { renderSkillsBlock } from "../render.ts";

let root: string;
let skillsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-skill-plugin-"));
  skillsDir = join(root, "skills");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAlpha(description = "does A"): Promise<void> {
  await mkdir(join(skillsDir, "alpha"), { recursive: true });
  await writeFile(join(skillsDir, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: ${description}\n---\nbody`);
}

interface World {
  readonly ctx: Context;
  readonly unload: readonly Disposer[];
  readonly session: Session;
  readonly warnings: readonly string[];
  readonly register: (session: Session) => void;
}

async function makeWorld(withSkill: boolean, noWarn = false): Promise<World> {
  if (withSkill) await writeAlpha();
  const live = new Map<SessionId, AgentHandle>();
  const loopStub = { get: (id: SessionId) => live.get(id) } as unknown as AgentLoopService;
  const stub: Plugin = {
    name: "agent-loop",
    apply: (ctx: Context) => {
      ctx.provide(agentLoopServiceToken, loopStub);
    },
  };
  const warnings: string[] = [];
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [
    stub,
    sessionPlugin,
    // noWarn=true 不传 onWarn——走 stderr 缺省路径（jsonl onIoError 同例的用例面）
    createSkillPlugin(noWarn ? { skillsDirs: [skillsDir] } : { skillsDirs: [skillsDir], onWarn: (message) => warnings.push(message) }),
  ]);
  const created = await ctx.use(sessionStore).create();
  if (!created.ok) throw new Error(created.reason);
  live.set(created.value.id, { agent: { session: created.value } } as unknown as AgentHandle);
  return { ctx, unload, session: created.value, warnings, register: (session) => live.set(session.id, { agent: { session } } as unknown as AgentHandle) };
}

function running(ctx: Context, session: SessionId): void {
  ctx.emit(agentStatus, { session, status: "running" });
}

function textBlocksOf(session: Session): string[] {
  return session
    .surface()
    .filter((node) => node.event.type === "user/message")
    .flatMap((node) => (node.event.data as { readonly content: readonly { type: string; text?: string }[] }).content)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "");
}

describe("createSkillPlugin 注入", () => {
  it("disabled 名单：合并后按名过滤——清单块不含禁用名、未禁用名保留", async () => {
    await writeAlpha();
    await mkdir(join(skillsDir, "beta"), { recursive: true });
    await writeFile(join(skillsDir, "beta", "SKILL.md"), `---\nname: beta\ndescription: does B\n---\nbody`);
    const warnings: string[] = [];
    const live = new Map<SessionId, AgentHandle>();
    const loopStub = { get: (id: SessionId) => live.get(id) } as unknown as AgentLoopService;
    const stub: Plugin = {
      name: "agent-loop",
      apply: (ctx: Context) => {
        ctx.provide(agentLoopServiceToken, loopStub);
      },
    };
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      stub,
      sessionPlugin,
      createSkillPlugin({ skillsDirs: [skillsDir], disabled: ["alpha"], onWarn: (message) => warnings.push(message) }),
    ]);
    const created = await ctx.use(sessionStore).create();
    if (!created.ok) throw new Error(created.reason);
    live.set(created.value.id, { agent: { session: created.value } } as unknown as AgentHandle);
    ctx.emit(agentStatus, { session: created.value.id, status: "running" });
    const blocks = textBlocksOf(created.value);
    expect(blocks.some((text) => text.includes("beta"))).toBe(true);
    expect(blocks.every((text) => !text.includes("alpha"))).toBe(true);
    for (const d of unload) await d();
  });

  it("running 注入：surface[0] 为清单块，deriveMessages 首位含块", async () => {
    await writeAlpha();
    const block = renderSkillsBlock((await loadSkills([skillsDir])).skills);
    const world = await makeWorld(true);
    running(world.ctx, world.session.id);
    const surface = world.session.surface();
    expect(surface[0]?.event.type).toBe("user/message");
    expect(textBlocksOf(world.session)).toEqual([block]);
    const messages = world.session.deriveMessages();
    expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: block }] });
  });

  it("同步红线：注入事件先于当轮 turn/start 落账", async () => {
    const world = await makeWorld(true);
    running(world.ctx, world.session.id);
    world.session.append("turn/start", { turn: 0 });
    const events = world.session.events();
    const injected = events.findIndex((event) => event.type === "user/message");
    const turnStart = events.findIndex((event) => event.type === "turn/start");
    expect(injected).toBeGreaterThanOrEqual(0);
    expect(turnStart).toBeGreaterThanOrEqual(0);
    expect(injected).toBeLessThan(turnStart);
  });

  it("幂等：多次 running 仅一块；块在场零追加", async () => {
    const world = await makeWorld(true);
    for (let i = 0; i < 3; i += 1) running(world.ctx, world.session.id);
    expect(textBlocksOf(world.session)).toHaveLength(1);
  });

  it("idle 边沿无动作", async () => {
    const world = await makeWorld(true);
    world.ctx.emit(agentStatus, { session: world.session.id, status: "idle" });
    expect(world.session.surface()).toHaveLength(0);
  });

  it("未知会话（loop.get 缺位）跳过不崩", async () => {
    const world = await makeWorld(true);
    running(world.ctx, "no-such-session" as SessionId);
    expect(world.session.surface()).toHaveLength(0);
  });

  it("预置同块（fork 继承语义）不再注入", async () => {
    const world = await makeWorld(true);
    expect(textBlocksOf(world.session)).toHaveLength(0);
    const expected = renderSkillsBlock((await loadSkills([skillsDir])).skills);
    world.session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: expected }] }, { surfaceOp: "append" });
    running(world.ctx, world.session.id);
    expect(textBlocksOf(world.session)).toEqual([expected]);
  });

  it("折叠自愈：尾块被 surface replace 折叠后，下次 running 补注入", async () => {
    const world = await makeWorld(true);
    running(world.ctx, world.session.id);
    const expected = textBlocksOf(world.session)[0] ?? "";
    const node = world.session.surface()[0];
    if (node === undefined) throw new Error("injected block node missing");
    const replaced = world.session.append(
      "user/message",
      { turn: 0, step: 0, content: [{ type: "text", text: "summary" }] },
      { surfaceOp: { op: "replace", startSeq: node.seq, endSeq: node.seq } },
    );
    expect(replaced.ok).toBe(true);
    expect(textBlocksOf(world.session)).not.toContain(expected);
    running(world.ctx, world.session.id);
    expect(textBlocksOf(world.session)).toContain(expected);
    expect(textBlocksOf(world.session)).toEqual(["summary", expected]);
  });

  it("封存会话：append 失败逐次告警不崩（防御分支——生产封存先摘句柄，走 loop.get 缺位路径）", async () => {
    const world = await makeWorld(true);
    const disposed = world.ctx.use(sessionStore).dispose(world.session.id);
    expect(disposed.ok).toBe(true);
    running(world.ctx, world.session.id);
    running(world.ctx, world.session.id);
    const failed = world.warnings.filter((message) => message.includes("append failed") && message.includes("session-disposed"));
    expect(failed).toHaveLength(2); // 每次 running 存在性检查重试，失败即告警，不崩不累积异常
  });

  it("头块（锚点前）经压缩折叠在场：replace 只吃锚点之后，块存活且不重注入", async () => {
    const world = await makeWorld(true);
    running(world.ctx, world.session.id);
    const block = textBlocksOf(world.session)[0] ?? "";
    expect(block).not.toBe("");
    // 构造 /compact 前形态：[skill块, system 锚点, 历史尾部]
    world.session.append("system/message", { turn: 0, step: 0, text: "system prompt" }, { surfaceOp: "append" });
    world.session.append("user/message", { turn: 1, step: 0, content: [{ type: "text", text: "old turn" }] }, { surfaceOp: "append" });
    const nodes = world.session.surface();
    const anchorSeq = nodes.find((node) => (node.event.data as { text?: string }).text !== undefined)?.seq;
    const tail = nodes[nodes.length - 1];
    if (anchorSeq === undefined || tail === undefined) throw new Error("anchor/tail missing");
    const replaced = world.session.append(
      "user/message",
      { turn: 1, step: 0, content: [{ type: "text", text: "summary" }] },
      { surfaceOp: { op: "replace", startSeq: tail.seq, endSeq: tail.seq } },
    );
    expect(replaced.ok).toBe(true);
    expect(textBlocksOf(world.session)).toContain(block); // 头块在锚点前，折叠后在场
    running(world.ctx, world.session.id);
    expect(textBlocksOf(world.session)).toEqual([block, "summary"]); // 幂等跳过——无第二块
  });

  it("多会话：各自首次注入一块", async () => {
    const world = await makeWorld(true);
    const second = await world.ctx.use(sessionStore).create();
    if (!second.ok) throw new Error(second.reason);
    world.register(second.value);
    running(world.ctx, world.session.id);
    running(world.ctx, second.value.id);
    expect(textBlocksOf(world.session)).toHaveLength(1);
    expect(textBlocksOf(second.value)).toHaveLength(1);
  });

  it("垃圾 skill 降级：告警上抛、合法项仍注入", async () => {
    await writeAlpha();
    await mkdir(join(skillsDir, "broken"), { recursive: true });
    await writeFile(join(skillsDir, "broken", "SKILL.md"), "no frontmatter");
    const world = await makeWorld(true);
    running(world.ctx, world.session.id);
    expect(world.warnings.some((message) => message.startsWith("skills: "))).toBe(true);
    expect(textBlocksOf(world.session)[0]).toContain("alpha");
  });

  it("零快照无痕：不注册监听、running 零事件", async () => {
    const world = await makeWorld(false);
    running(world.ctx, world.session.id);
    expect(world.session.surface()).toHaveLength(0);
    expect(world.warnings).toEqual([]);
  });

  it("onWarn 缺省写 stderr：不接告警的宿主也不静默", async () => {
    await writeAlpha();
    await mkdir(join(skillsDir, "broken"), { recursive: true });
    await writeFile(join(skillsDir, "broken", "SKILL.md"), "no frontmatter");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await makeWorld(true, true);
      expect(stderr.mock.calls.some(([text]) => String(text).startsWith("skills: "))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("dispose 摘除监听：卸载后 running 不再注入", async () => {
    const world = await makeWorld(true);
    await Promise.all(world.unload.map((off) => off()));
    running(world.ctx, world.session.id);
    expect(world.session.surface()).toHaveLength(0);
  });
});
