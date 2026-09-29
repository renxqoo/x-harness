import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import { createBasePromptPlugin } from "../base-prompt.ts";
import { createWorktreeContextPlugin } from "../worktree-context.ts";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

let scratch: string | undefined;

afterEach(async () => {
  if (scratch !== undefined) {
    await rm(join(dirname(scratch), ".x-harness-worktrees"), { recursive: true, force: true }).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  scratch = undefined;
});

async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "xh-adv-wt-"));
  scratch = root;
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

function textStream(text: string): AsyncGenerator<LlmChunk> {
  return (async function* (): AsyncGenerator<LlmChunk> {
    yield { type: "text", delta: text } as unknown as LlmChunk;
    yield { type: "finish", finish: { kind: "stop" } } as unknown as LlmChunk;
  })();
}

const systemTextOf = (request: LlmRequest): string =>
  (request.messages.find((m) => m.role === "system") as { text?: string } | undefined)?.text ?? "";

describe("Track U 真实消费路径（untyped worktree 子经 agent_spawn）", { timeout: 30_000 }, () => {
  it("untyped worktree 子：system 应含完整 base/core（You are xh）+ worktree ENV（会话层覆盖）", async () => {
    const repo = await gitRepo();
    const ctx = createContext();
    const calls: LlmRequest[] = [];
    await loadPlugins(ctx, [
      sessionPlugin,
      toolsPlugin,
      llmPlugin,
      systemPromptPlugin,
      createBasePromptPlugin({ cwd: repo, isGit: true, platform: process.platform, shell: "zsh" }),
      createWorktreeContextPlugin({ facts: { cwd: repo, isGit: true, platform: process.platform, shell: "zsh" } }),
      agentLoopPlugin,
      createTaskToolsPlugin(),
      { name: "grants-stub", apply: (c) => c.provide(permissionGrants, new GrantsRegistry()) },
      createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: repo, worktreeSweep: false }),
    ]);
    const off = ctx.use(llmRuntime).registerAdapter({
      name: "fake",
      stream: (request) => {
        calls.push(request);
        return textStream("ok");
      },
    });
    ctx.effect(off);

    const loop = ctx.use(agentLoopServiceToken);
    const registry = ctx.use(toolRegistry);
    const made = await loop.create({ agent: { model: "m", provider: "fake" } });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const parent = made.value;
    parent.agent.followup("go");
    await parent.agent.whenIdle();
    const parentCalls = calls.length;

    const spawned = await registry.dispatch({
      callId: "adv-1",
      name: "agent_spawn",
      args: { description: "isolated work", prompt: "do work", isolation: "worktree" },
      signal: new AbortController().signal,
      session: parent.agent.session.id,
    });
    expect(spawned.isError).toBeUndefined();
    const agentId = (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] as string;
    const wtParent = join(dirname(repo), ".x-harness-worktrees");
    const entry = (await readdir(wtParent)).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(wtParent, entry);
    expect(existsSync(join(wtPath, ".git"))).toBe(true);

    await sleep(600);
    const childCalls = calls.slice(parentCalls);
    expect(childCalls.length).toBeGreaterThan(0);
    const childSystem = childCalls.map(systemTextOf).join("\n@@@\n");
    expect(childSystem).toContain("You are xh");
    expect(childSystem).toContain(`- Working directory: ${wtPath}`);
    expect(childSystem).toContain(`- Git branch: x-harness/${agentId}`);
    expect(ctx.use(systemPrompt).assemble().text).toContain(`- Working directory: ${repo}`);
    await parent.dispose();
    await ctx.dispose();
  });
});
