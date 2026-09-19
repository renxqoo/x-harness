// cli-core section 注册（docs/CLI.md §2.5）：variable 插值生效、追加段顺序在 core 后、
// 注销器整体回收。

import { describe, expect, it } from "vitest";
import { systemPromptPlugin, systemPrompt } from "@x-harness/system-prompt";
import type { SystemPromptService } from "@x-harness/system-prompt";
import { createContext, loadPlugins } from "@x-harness/core";
import { coreSectionText, registerCliPromptSections } from "../cli-prompt-sections.ts";
import type { PromptFacts } from "../cli-prompt-sections.ts";

const FACTS: PromptFacts = { cwd: "/tmp/proj", platform: "darwin", date: "2026-09-19" };

async function makePrompt(): Promise<SystemPromptService> {
  const ctx = createContext();
  await loadPlugins(ctx, [systemPromptPlugin]);
  return ctx.use(systemPrompt);
}

describe("registerCliPromptSections", () => {
  it("cli-core 插值环境事实（{{var}} 全展开，无残留占位）", async () => {
    const prompt = await makePrompt();
    registerCliPromptSections(prompt, FACTS, []);
    const text = prompt.assemble().text;
    expect(text).toContain("/tmp/proj");
    expect(text).toContain("darwin");
    expect(text).toContain("2026-09-19");
    expect(text).not.toContain("{{");
  });

  it("追加段按序出现在 cli-core 之后", async () => {
    const prompt = await makePrompt();
    registerCliPromptSections(prompt, FACTS, ["FIRST-APPEND", "SECOND-APPEND"]);
    const text = prompt.assemble().text;
    const core = text.indexOf("You are x-harness");
    const first = text.indexOf("FIRST-APPEND");
    const second = text.indexOf("SECOND-APPEND");
    expect(core).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(core);
    expect(second).toBeGreaterThan(first);
  });

  it("注销后 section 与 variable 一并回收", async () => {
    const prompt = await makePrompt();
    const off = registerCliPromptSections(prompt, FACTS, ["GONE"]);
    expect(prompt.assemble().text).toContain("GONE");
    off();
    const after = prompt.assemble().text;
    expect(after).not.toContain("GONE");
    expect(after).not.toContain("You are x-harness");
  });

  it("coreSectionText 纯函数不含运行事实（占位由 variable 层注入）", () => {
    const text = coreSectionText();
    expect(text).toContain("{{cwd}}");
    expect(text).toContain("{{platform}}");
    expect(text).toContain("{{date}}");
  });
});
