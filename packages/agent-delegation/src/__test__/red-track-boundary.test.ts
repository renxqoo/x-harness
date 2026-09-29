import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, resetWorlds, sessionOf } from "./world.ts";

const exec = promisify(execFile);

let repo: string | undefined;
let fixtureRoot: string | undefined;

beforeEach(() => {
  resetWorlds();
});

afterEach(async () => {
  if (repo !== undefined) await rm(join(dirname(repo), ".x-harness-worktrees"), { recursive: true, force: true }).catch(() => {});
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  fixtureRoot = undefined;
  repo = undefined;
});

async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "xh-redwt-p-"));
  fixtureRoot = root;
  const parent = mkdtempSync(join(root, "d-"));
  const dir = join(parent, "repo");
  mkdirSync(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  return realpathSync(dir);
}

const grantsStub = (): Plugin => ({
  name: "grants-stub",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
});

async function worktreeWorld(types: Record<string, { readonly model?: string; readonly body?: string }>) {
  const options = await makeOptions(types, { workspaceRoot: repo as string, worktreeSweep: false });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "redwt-main" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "c")]);
  return { world, parent };
}

const spawnChild = (world: Awaited<ReturnType<typeof worktreeWorld>>, args: Record<string, unknown>) =>
  callTool({ world: world.world, name: "agent_spawn", args: { description: "isolated work", prompt: "x", ...args }, session: world.parent.agent.session.id });

describe("红测：Track N 拼接边界（untyped/fork/空正文 named 的 worktree 子丢全量 base/core）", { timeout: 20_000 }, () => {
  it("untyped + isolation=worktree：options.systemPrompt 应缺席（走 assemble/Track U）——现状被拼成环境块独占串", async () => {
    repo = await gitRepo();
    const world = await worktreeWorld({});
    const spawned = await spawnChild(world, { isolation: "worktree" });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    const child = world.world.loop.get(childSession);
    expect(child?.agent.options.systemPrompt).toBeUndefined();
    await world.parent.dispose();
  });

  it("fork + isolation=worktree：同 untyped——options.systemPrompt 应缺席", async () => {
    repo = await gitRepo();
    const world = await worktreeWorld({});
    const spawned = await spawnChild(world, { subagent_type: "fork", isolation: "worktree" });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    const child = world.world.loop.get(childSession);
    expect(child?.agent.options.systemPrompt).toBeUndefined();
    await world.parent.dispose();
  });

  it("空正文 named 类型 + isolation=worktree：options.systemPrompt 应缺席（既有语义 = 无 persona 不设静态串）", async () => {
    repo = await gitRepo();
    const world = await worktreeWorld({ blank: { model: CHILD_MODEL, body: "" } });
    const spawned = await spawnChild(world, { subagent_type: "blank", isolation: "worktree" });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    const child = world.world.loop.get(childSession);
    expect(child?.agent.options.systemPrompt).toBeUndefined();
    await world.parent.dispose();
  });

  it("回归锚：非 worktree 的 untyped / 空正文 named 子不设 systemPrompt（既有语义）", async () => {
    repo = await gitRepo();
    const world = await worktreeWorld({ blank: { model: CHILD_MODEL, body: "" } });
    const plain = await spawnChild(world, {});
    expect(plain.isError).toBeUndefined();
    expect(world.world.loop.get(sessionOf(plain.content))?.agent.options.systemPrompt).toBeUndefined();
    const blankPlain = await spawnChild(world, { subagent_type: "blank" });
    expect(blankPlain.isError).toBeUndefined();
    expect(world.world.loop.get(sessionOf(blankPlain.content))?.agent.options.systemPrompt).toBeUndefined();
    await world.parent.dispose();
  });

  it("回归锚：非空正文 named + worktree 仍拼环境块（Track N 主路径不受影响）", async () => {
    repo = await gitRepo();
    const world = await worktreeWorld({ worker: { model: CHILD_MODEL, body: "you are a worker" } });
    const spawned = await spawnChild(world, { subagent_type: "worker", isolation: "worktree" });
    expect(spawned.isError).toBeUndefined();
    const child = world.world.loop.get(sessionOf(spawned.content));
    expect(child?.agent.options.systemPrompt).toContain("you are a worker");
    expect(child?.agent.options.systemPrompt).toContain("- Git branch: x-harness/");
    await world.parent.dispose();
  });

  it("复活链（revivedOptions）同缺陷：untyped 档案 + 树在场 → 静态环境块独占（复活预解析前移引入）", async () => {
    repo = await gitRepo();
    const { createJsonlSessionPersistence } = await import("@x-harness/session-persistence-jsonl");
    const persistRoot = mkdtempSync(join(tmpdir(), "xh-redwt-s-"));
    const makePersisted = async () => {
      const options = await makeOptions({}, { workspaceRoot: repo as string, worktreeSweep: false });
      return makeWorld(options, undefined, [grantsStub(), createJsonlSessionPersistence({ root: persistRoot })]);
    };
    try {
      const first = await makePersisted();
      const parent = await spawnParent(first, PARENT_MODEL, "redwt-rv" as SessionId);
      first.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      first.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "c")]);
      const spawned = await callTool({ world: first, name: "agent_spawn", args: { description: "iso", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
      expect(spawned.isError).toBeUndefined();
      const childSession0 = sessionOf(spawned.content);
      const { sessionStore } = await import("@x-harness/session");
      await first.ctx.use(sessionStore).flush(childSession0);
      await first.ctx.use(sessionStore).flush(parent.agent.session.id);
      await first.disposePlugins();

      const second = await makePersisted();
      await second.loop.resume({ id: parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const revived = await callTool({ world: second, name: "agent_message", args: { to: (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0], message: "continue" }, session: parent.agent.session.id });
      expect(revived.isError).toBeUndefined();
      const childSession = (revived.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
      const child = second.loop.get(childSession);
      expect(child?.agent.options.systemPrompt).toBeUndefined();
      await second.loop.get(parent.agent.session.id)?.dispose();
      await second.disposePlugins();
    } finally {
      await rm(persistRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});
