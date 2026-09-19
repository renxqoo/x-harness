// 追加段链 + 环境事实探测（docs/CLI.md §2.5）：基础段归 @x-harness/system-prompt
// （包内 base-plugin.test 覆盖）；本层只测 appends 链（落尾语义/注销回收/与工具段共序）
// 与 promptFactsOf（isGit 祖先上寻/shell 归一/date 本地格式）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { createLocalEnv } from "@x-harness/exec-env";
import { wellKnown, systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import { createBasePromptPlugin } from "../base-prompt.ts";
import type { BasePromptFacts } from "../base-prompt.ts";
import type { SystemPromptService } from "@x-harness/system-prompt";
import { toolsPlugin } from "@x-harness/tools";
import { bashGuidance } from "@x-harness/tool-bash";
import { PathGate, createToolPlugin } from "@x-harness/tool-core";
import { promptFactsOf, registerAppendSections } from "../cli-prompt-sections.ts";

const FACTS: BasePromptFacts = { cwd: "/tmp/proj", isGit: false, platform: "darwin", shell: "zsh", date: "2026-09-20" };

async function makePrompt(): Promise<SystemPromptService> {
  const ctx = createContext();
  await loadPlugins(ctx, [systemPromptPlugin, createBasePromptPlugin(FACTS)]);
  return ctx.use(systemPrompt);
}

describe("registerAppendSections", () => {
  it("追加段按序落在基础段之后（无边落尾 = 全部内置段之后）", async () => {
    const prompt = await makePrompt();
    registerAppendSections(prompt, ["FIRST-APPEND", "SECOND-APPEND"]);
    const text = prompt.assemble().text;
    const base = text.indexOf("You are Agent");
    const first = text.indexOf("FIRST-APPEND");
    const second = text.indexOf("SECOND-APPEND");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(base);
    expect(second).toBeGreaterThan(first);
  });

  it("与工具段共序：tool/<name> 停靠段（after baseCore）仍先于追加段", async () => {
    const prompt = await makePrompt();
    prompt.section({ name: "tool/bash", after: wellKnown.baseCore, text: "## Shell\n\nfence rule" });
    registerAppendSections(prompt, ["TAIL-APPEND"]);
    const text = prompt.assemble().text;
    expect(text.indexOf("## Shell")).toBeGreaterThan(text.indexOf("You are Agent"));
    expect(text.indexOf("TAIL-APPEND")).toBeGreaterThan(text.indexOf("## Shell"));
  });

  it("注销后追加段回收，基础段保留", async () => {
    const prompt = await makePrompt();
    const off = registerAppendSections(prompt, ["GONE"]);
    expect(prompt.assemble().text).toContain("GONE");
    off();
    const after = prompt.assemble().text;
    expect(after).not.toContain("GONE");
    expect(after).toContain("You are Agent");
  });
});

describe("promptFactsOf（宿主探测）", () => {
  it("isGit 祖先上寻（worktree file 形态算）；shell 换行归一；date 本地 yyyy-mm-dd", () => {
    const root = mkdtempSync(join(tmpdir(), "xh-facts-"));
    try {
      expect(promptFactsOf({ cwd: root, platform: "darwin", env: {} }).isGit).toBe(false);
      writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n"); // worktree file 形态
      mkdirSync(join(root, "sub"));
      const facts = promptFactsOf({ cwd: join(root, "sub"), platform: "darwin", env: { SHELL: "/bin/zsh\n" } });
      expect(facts.isGit).toBe(true); // 自 sub 上寻命中
      expect(facts.shell).toBe("/bin/zsh"); // 换行被入口归一压掉
      expect(facts.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(facts.cwd).toBe(join(root, "sub"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("env.SHELL 缺席 → unknown（垃圾降级，绝不空值）", () => {
    const facts = promptFactsOf({ cwd: "/w", platform: "linux", env: {} });
    expect(facts.shell).toBe("unknown");
  });
});

describe("CLI 形态世界 prompt 组装（W1 审查 M-1 处置——等价验收工件）", () => {
  it("生产序世界：base 全段在序 + facts 插值 + local env bash 零段 + 追加段落尾（组合回归锚）", async () => {
    const ctx = createContext();
    const facts: BasePromptFacts = { cwd: "/w/proj", isGit: true, platform: "darwin", shell: "zsh", date: "2026-09-20" };
    const root = mkdtempSync(join(tmpdir(), "xh-cli-prompt-"));
    try {
      const unload = await loadPlugins(ctx, [
        systemPromptPlugin, // D6 硬约束：前置于带 guidance 的 tool-*
        createBasePromptPlugin(facts),
        toolsPlugin,
        createToolPlugin({ name: "tool-bash", gate: new PathGate(root), envOption: createLocalEnv(root), make: () => ({ name: "bash", description: "bash", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) }), guidance: bashGuidance }),
      ]);
      const prompt = ctx.use(systemPrompt);
      const offAppend = registerAppendSections(prompt, ["EXTRA-RULE"]);
      const text = prompt.assemble().text;
      // base 全段按序（游标单调推进）
      const order = ["You are Agent", "## Security", "## Conduct", "## Tone", "## Tool Use", "## Making Changes", "## Safety", "## Environment", "## Context Management", "## Output Format"];
      let cursor = -1;
      for (const part of order) {
        const at = text.indexOf(part);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(text).toContain("- Working directory: /w/proj");
      expect(text).toContain("- Is a git repository: yes");
      expect(text).not.toContain("{{"); // facts 全插值
      expect(text).not.toContain("## Shell"); // local env → bashGuidance 空串 → 零停靠段（W1 等价语义）
      expect(text.indexOf("EXTRA-RULE")).toBeGreaterThan(cursor); // 追加段落尾
      offAppend();
      for (const dispose of unload) await dispose();
      await ctx.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
