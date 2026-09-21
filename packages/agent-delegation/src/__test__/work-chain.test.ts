// work 链（T39 D10.2）：spawn description 全程可见——agentSpawned 载荷、ChildView
// 快照、header.agentWork 持久锚、复活回填四面对照（缺一面即中途丢弃）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { sessionStore } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, workerOptions, resetWorlds, agentIdOf, sessionOf } from "./world.ts";
import { agentSpawned } from "../tokens.ts";
import type { AgentSpawnedPayload } from "../tokens.ts";
import { delegationView } from "../view.ts";
import type { ChildView } from "../types.ts";
import type { SessionId } from "@x-harness/session";
import type { World } from "./world.ts";

const hasTurnEnd = (world: World, session: SessionId): boolean =>
  world.ctx.use(sessionStore).get(session)?.events().some((e: { type: string }) => e.type === "turn/end") ?? false;

beforeEach(() => {
  resetWorlds();
});

const subagentRows = (views: readonly ChildView[]): Extract<ChildView, { kind: "subagent" }>[] =>
  views.filter((v): v is Extract<ChildView, { kind: "subagent" }> => v.kind === "subagent");

describe("work 链四面对照", () => {
  it("spawn：payload 与 ChildView 同源带 work（= description 原文）", async () => {
    const world = await makeWorld(await workerOptions());
    const spawnedLog: AgentSpawnedPayload[] = [];
    world.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "audit the parser edge cases", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(spawnedLog).toHaveLength(1), { timeout: 5_000 });
    expect(spawnedLog[0]?.work).toBe("audit the parser edge cases");
    const view = world.ctx.tryUse(delegationView);
    const rows = subagentRows(await view?.list(parent.agent.session.id) ?? []);
    expect(rows.find((r) => r.agentId === agentIdOf(spawned.content))?.work).toBe("audit the parser edge cases");
    await parent.dispose();
  });

  it("持久锚与复活回填：header.json 落 agentWork，重启复活后 payload/view 恢复 work", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-work-"));
    try {
      const first = await makeWorld(await workerOptions(), undefined, [createJsonlSessionPersistence({ root })]);
      const firstParent = await spawnParent(first);
      first.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "cycle one")]);
      const spawned = await callTool({ world: first, name: "agent_spawn", args: { description: "summarize the logs", prompt: "x", subagent_type: "worker" }, session: firstParent.agent.session.id });
      const agentId = agentIdOf(spawned.content);
      const childSession = sessionOf(spawned.content);
      await vi.waitFor(() => {
        expect(hasTurnEnd(first, childSession)).toBe(true);
      }, { timeout: 5_000 });
      await first.ctx.use(sessionStore).flush(childSession);
      await first.ctx.use(sessionStore).flush(firstParent.agent.session.id);
      // 持久锚：磁盘 header.json 含 agentWork（跨重启载体）
      const headerRaw = await readFile(join(root, childSession, "header.json"), "utf8");
      expect(JSON.parse(headerRaw).agentWork).toBe("summarize the logs");
      await first.disposePlugins();

      const second = await makeWorld(await workerOptions(), undefined, [createJsonlSessionPersistence({ root })]);
      const spawnedLog: AgentSpawnedPayload[] = [];
      second.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
      await second.loop.resume({ id: firstParent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      second.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "cycle two")]);
      const woke = await callTool({ world: second, name: "agent_message", args: { to: agentId, message: "again" }, session: firstParent.agent.session.id });
      expect(woke.isError).toBeUndefined();
      await vi.waitFor(() => expect(spawnedLog).toHaveLength(1), { timeout: 5_000 });
      expect(spawnedLog[0]?.work).toBe("summarize the logs"); // 复活发射回填
      const rows = subagentRows(await second.ctx.tryUse(delegationView)?.list(firstParent.agent.session.id) ?? []);
      expect(rows.find((r) => r.agentId === agentId)?.work).toBe("summarize the logs");
      await second.disposePlugins();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("旧档案（header 无 agentWork）复活：work 键缺席不崩——payload/view 均无 work", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-work-old-"));
    try {
      const first = await makeWorld(await workerOptions(), undefined, [createJsonlSessionPersistence({ root })]);
      const firstParent = await spawnParent(first);
      first.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "cycle one")]);
      const spawned = await callTool({ world: first, name: "agent_spawn", args: { description: "will be erased", prompt: "x", subagent_type: "worker" }, session: firstParent.agent.session.id });
      const agentId = agentIdOf(spawned.content);
      const childSession = sessionOf(spawned.content);
      await vi.waitFor(() => {
        expect(hasTurnEnd(first, childSession)).toBe(true);
      }, { timeout: 5_000 });
      await first.ctx.use(sessionStore).flush(childSession);
      await first.ctx.use(sessionStore).flush(firstParent.agent.session.id);
      await first.disposePlugins();

      // 手植旧形态 header：抹掉 agentWork（字段引入前的档案形状）
      const headerPath = join(root, childSession, "header.json");
      const header = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, unknown>;
      delete header["agentWork"];
      await writeFile(headerPath, `${JSON.stringify(header)}\n`, "utf8");

      const second = await makeWorld(await workerOptions(), undefined, [createJsonlSessionPersistence({ root })]);
      const spawnedLog: AgentSpawnedPayload[] = [];
      second.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
      await second.loop.resume({ id: firstParent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      second.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "old cycle")]);
      const woke = await callTool({ world: second, name: "agent_message", args: { to: agentId, message: "again" }, session: firstParent.agent.session.id });
      expect(woke.isError).toBeUndefined();
      await vi.waitFor(() => expect(spawnedLog).toHaveLength(1), { timeout: 5_000 });
      expect("work" in (spawnedLog[0] ?? {})).toBe(false); // 键缺席而非 undefined 占位
      const rows = subagentRows(await second.ctx.tryUse(delegationView)?.list(firstParent.agent.session.id) ?? []);
      const revived = rows.find((r) => r.agentId === agentId);
      expect(revived).toBeDefined();
      expect("work" in (revived ?? {})).toBe(false);
      await second.disposePlugins();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
