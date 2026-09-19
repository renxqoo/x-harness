// 组合层桥接（docs/CLI.md §2.5）：ToolDefinition.guidance（纯数据）→ system-prompt 段
// 的提升逻辑——guidance 在场成段（锚 base/core）、缺席零段、注入 topo 序（数组序颠倒亦保序）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate, createToolPlugin } from "@x-harness/tool-core";
import { createBasePromptPlugin, systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { BasePromptFacts } from "@x-harness/system-prompt";
import { toolGuidanceBridge } from "../build-world.ts";

const FACTS: BasePromptFacts = { cwd: "/w", isGit: false, platform: "darwin", shell: "zsh", date: "2026-09-20" };

const probe = (): ToolDefinition => ({
  name: "probe",
  description: "probe",
  inputSchema: Type.Object({}),
  execute: async () => ({ content: "ok" }),
});

let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("toolGuidanceBridge（组合层桥接）", () => {
  it("guidance 在场 → section tool/<name>（after base/core）；拆卸回收", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-bridge-"));
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(FACTS),
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate: new PathGate(root), envOption: createLocalEnv(root), make: () => probe(), guidance: "## Probe\n\nprobe rule" }),
      toolGuidanceBridge,
    ]);
    const prompt = ctx.use(systemPrompt);
    const text = prompt.assemble().text;
    expect(text).toContain("probe rule");
    expect(text.indexOf("## Output Format")).toBeLessThan(text.indexOf("## Probe")); // 锚 base/core：整段之后
    for (const dispose of unload) await dispose();
    expect(prompt.assemble().text).not.toContain("probe rule");
    await ctx.dispose();
  });

  it("guidance 缺席 → 零段（assemble 无 tool/ 段）", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-bridge-"));
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(FACTS),
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate: new PathGate(root), envOption: createLocalEnv(root), make: () => probe() }),
      toolGuidanceBridge,
    ]);
    expect(ctx.use(systemPrompt).assemble().text).not.toContain("## Probe");
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });
});
