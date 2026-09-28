// 对抗审查红测（7c16b4e harness 面·第 2 批）：面 1（layers Map 生命周期边界——
// 非 worktree 子的 gone 事件 no-op 无泄漏、同 session 反复 emit 复活路径、插件
// dispose 顺序）；面 4（probeGitFacts 一致性窗口——isGit 与 git facts 两次游走）；
// 面 6（delegationKit 签名破坏性变更的漏改点——docs/SDK-DESIGN.md:57 仍是旧签名）。

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { sessionDisposed, sessionPlugin } from "@x-harness/session";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { llmPlugin } from "@x-harness/llm";
import { toolsPlugin } from "@x-harness/tools";
import { agentSpawned, agentWorktreeGone } from "@x-harness/agent-delegation";
import { probeBaseFacts, probeGitFacts } from "../base-prompt-probe.ts";
import { createWorktreeContextPlugin } from "../worktree-context.ts";
import { delegationKit } from "../index.ts";

const FACTS = { cwd: "/w/main", isGit: true, platform: "darwin", shell: "zsh" } as const;
const WT = "/wt/x-harness-agent-0123abcd";

const spawnedPayload = (over: Record<string, unknown> = {}) => ({
  parent: "p1" as never,
  agentId: "agent-0123abcd",
  sessionId: "c1" as never,
  type: "untyped",
  depth: 1,
  ...over,
});

describe("面 1：layers Map 无界增长路径", () => {
  it("named 子不发 agentSpawned 注册，但 gone 事件对所有 worktree 子都发 → drop no-op 无泄漏（核实无问题）", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin, createWorktreeContextPlugin({ facts: FACTS })]);
    const prompt = ctx.use(systemPrompt);
    const before = prompt.assemble().text;
    ctx.emit(agentWorktreeGone, { sessionId: "never-registered" as never, agentId: "agent-x" });
    expect(prompt.assemble().text).toBe(before); // no-op，无异常
    await ctx.dispose();
  });

  it("sessionDisposed 后 Map 清理 + 再 emit 不复活（同 sessionId 复用形态）", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [systemPromptPlugin, createWorktreeContextPlugin({ facts: FACTS })]);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b1" }));
    expect(prompt.assemble({ sessionId: "c1" }).text).toContain(WT);
    ctx.emit(sessionDisposed, { session: "c1" as never });
    expect(prompt.assemble({ sessionId: "c1" }).text).not.toContain(WT);
    // 同 sessionId 再 emit（新会话复用 id——mintSessionId 时间戳形实际不重，但 Map 语义应稳）
    ctx.emit(agentSpawned, spawnedPayload({ worktree: WT, branch: "b2" }));
    expect(prompt.assemble({ sessionId: "c1" }).text).toContain("- Git branch: b2");
    await ctx.dispose();
  });

  it("真实会话链：子会话 dispose → sessionDisposed → 层摘（端到端核实主清理路径）", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [
      sessionPlugin,
      toolsPlugin,
      llmPlugin,
      systemPromptPlugin,
      createWorktreeContextPlugin({ facts: FACTS }),
      agentLoopPlugin,
    ]);
    const loop = ctx.use(agentLoopServiceToken);
    const made = await loop.create({});
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const childId = String(made.value.agent.session.id);
    const prompt = ctx.use(systemPrompt);
    ctx.emit(agentSpawned, spawnedPayload({ sessionId: childId, worktree: WT, branch: "b1" }));
    expect(prompt.assemble({ sessionId: childId }).text).toContain(WT);
    await made.value.dispose(); // → sessionDisposed → dropLayer + 插件 Map 清
    expect(prompt.assemble({ sessionId: childId }).text).not.toContain(WT);
    await ctx.dispose();
  });
});

describe("面 4：probeGitFacts 一致性窗口与 symlink 口径", () => {
  it("isGit=true + gitBranch 缺席（detached HEAD 主仓）——两键解耦一致渲染", () => {
    const root = mkdtempSync(join(tmpdir(), "xh-adv4-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "4a1b2c3d4e5f60718293a4b5c6d7e8f901234567\n");
      const facts = probeBaseFacts({ cwd: root, platform: "darwin", env: {} });
      expect(facts.isGit).toBe(true);
      expect(facts.gitBranch).toBeUndefined(); // detached——键省略
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlink 子目录上寻：resolve 形命中（逻辑路径），realpath 口径差仅是字符串形态（无事实错报）", () => {
    const root = mkdtempSync(join(tmpdir(), "xh-adv4b-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      const link = join(root, "link");
      symlinkSync(join(root, "sub"), link);
      const facts = probeGitFacts(link);
      expect(facts.branch).toBe("main"); // resolve 后上寻命中——事实正确
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cwd 被 .git 目录删除的窗口（isGit 游走在前、findGitEntry 在后）——isGit 可能 true 而 branch 省（可接受的降级形态）", () => {
    const root = mkdtempSync(join(tmpdir(), "xh-adv4c-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      // 模拟竞态：isGitWorkdir（probeBaseFacts 内先跑）与 probeGitFacts 各自游走。
      // 单线程内无法真正交错——此处锁「两函数独立游走」的结构性事实：
      const a = probeGitFacts(root);
      expect(a).toEqual({ branch: "main" });
      rmSync(join(root, ".git"), { recursive: true, force: true });
      const b = probeGitFacts(root);
      expect(b).toEqual({}); // 删除后双键省略——与 isGit 无关
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("面 5：normalizeBaseFacts optional 归一", () => {
  it("gitBranch 含 \\r\\n → inline 压空格（与 base-prompt 同口径）", async () => {
    const { normalizeBaseFacts } = await import("../base-prompt.ts");
    const n = normalizeBaseFacts({ cwd: "/w", isGit: true, gitBranch: "b\r\ninjected", gitWorktreeMain: "/m\r\nx", platform: "p", shell: "s" });
    expect(n.gitBranch).toBe("b injected");
    expect(n.gitWorktreeMain).toBe("/m x");
  });

  it("非 string（数字/对象/null）→ 键省略", async () => {
    const { normalizeBaseFacts } = await import("../base-prompt.ts");
    const n = normalizeBaseFacts({ cwd: "/w", isGit: true, gitBranch: 42, gitWorktreeMain: { evil: true }, platform: "p", shell: "s" });
    expect(n.gitBranch).toBeUndefined();
    expect(n.gitWorktreeMain).toBeUndefined();
  });
});

describe("面 6：delegationKit 签名破坏性变更", () => {
  it("delegationKit 两参与时装配成功（类型面核实——漏改点由 tsc 抓）", async () => {
    const kit = delegationKit({ agentsDirs: [], workspaceRoot: "/w/main" }, FACTS);
    expect(kit).toHaveLength(2); // delegation + worktree-context 双插件
    expect(kit.map((p) => p.name)).toEqual(["agent-delegation", "worktree-context"]);
  });
});

import { symlinkSync } from "node:fs";
