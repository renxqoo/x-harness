// 追加段链 + 环境事实探测（docs/CLI.md §2.5）：基础段归 @x-harness/system-prompt
// （包内 base-plugin.test 覆盖）；本层只测 appends 链（落尾语义/注销回收/与工具段共序）
// 与 promptFactsOf（isGit 祖先上寻/shell 归一/date 本地格式）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { baseCore, createBasePromptPlugin, systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { BasePromptFacts, SystemPromptService } from "@x-harness/system-prompt";
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

  it("与工具段共序：tool/<name> 桥接段（after baseCore）仍先于追加段", async () => {
    const prompt = await makePrompt();
    prompt.section({ name: "tool/bash", after: baseCore, text: "## Shell\n\nfence rule" });
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
