import { afterAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnScriptWorker, waitEvent, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptStep } from "../shared/script-adapter.ts";
import { assembleWorkerAgent, teardownWorld } from "../worker/assembly.ts";
import { agentSpawned } from "@x-harness/agent-delegation";
import { systemPrompt } from "@x-harness/system-prompt";

const exec = promisify(execFile);

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function gitRepo(): Promise<string> {
  const parent = await tempDir("hub-wta-repo-p-");
  const dir = join(parent, "repo");
  await mkdir(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  return dir;
}

describe("hub worker 装配面（Track U 插件在场性）", () => {
  test("defaultWorkerPlugins 装配含 worktree-context（agentSpawned → 子会话 base/core 被顶替——行为面直测）", async () => {
    const sessionsRoot = await tempDir("hub-wta-sess-");
    const assembled = await assembleWorkerAgent({
      sessionsRoot,
      cwd: await tempDir("hub-wta-cwd-"),
      trusted: false,
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]) },
    });
    const prompt = assembled.world.ctx.use(systemPrompt);
    const before = prompt.assemble();
    assembled.world.ctx.emit(agentSpawned, { parent: "p0" as never, agentId: "agent-0123abcd", sessionId: "c-wt" as never, type: "untyped", depth: 1, worktree: "/wt/x", branch: "x-harness/agent-0123abcd", worktreeMain: "/w/main" });
    const covered = prompt.assemble({ sessionId: "c-wt" });
    expect(covered.text).toContain("- Working directory: /wt/x");
    expect(prompt.assemble().fingerprint).toBe(before.fingerprint);
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
  }, 20_000);
});

describe("embedded worker worktree 旅程（Track N——builtin named 子 + isolation:worktree）", () => {
  test("真 git cwd 起 thread → spawn worktree 子 → 子会话 system/message 含 worktree 环境块", async () => {
    const repo = await gitRepo();
    const script: readonly ScriptStep[] = [
      { toolCalls: [{ name: "agent_spawn", input: '{"description":"iso work","prompt":"do work","subagent_type":"general-purpose","isolation":"worktree"}' }] },
      { reply: "parent continues" },
      { reply: "child done" },
    ];
    const w = await spawnScriptWorker({ script });
    try {
      w.send({ type: "thread/start", id: "s1", cwd: repo, trusted: true, permissionMode: "full" });
      const started = await waitResponse(w.captured.lines, "thread/start", "s1");
      if (!started.success) throw new Error(String(started.error));
      const threadId = (started.data as { threadId: string }).threadId;
      w.send({ type: "prompt", id: "p1", threadId, message: "spawn one" });
      await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
      w.send({ type: "get_subagents", id: "sa1", threadId });
      const subs = await waitResponse(w.captured.lines, "get_subagents", "sa1");
      const rows = (subs.data as { subagents: Array<{ agentId?: string; worktree?: string }> }).subagents;
      const row = rows.find((r) => r.worktree !== undefined);
      expect(row?.worktree).toBeDefined();
      expect(row?.worktree).toContain("x-harness-worktrees");
      const wtPath = row?.worktree ?? "";
      const { readdir, readFile } = await import("node:fs/promises");
      const entries = await readdir(w.sessionsRoot);
      const childDirs = entries.filter((e) => e !== threadId);
      expect(childDirs.length).toBeGreaterThanOrEqual(1);
      let found = false;
      for (const dir of childDirs) {
        const raw = await readFile(join(w.sessionsRoot, dir, "events.jsonl"), "utf8").catch(() => "");
        if (raw.includes(wtPath) && raw.includes("isolated git worktree")) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
      w.send({ type: "thread/stop", id: "sp1", threadId });
      await waitResponse(w.captured.lines, "thread/stop", "sp1");
      await rm(join(repo, "..", ".x-harness-worktrees"), { recursive: true, force: true }).catch(() => {});
    } finally {
      w.input.end();
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }
  }, 40_000);
});
