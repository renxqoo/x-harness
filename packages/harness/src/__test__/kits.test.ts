// F1 kit 形状 + createAgentWorld（SDK-MIGRATION-F1 §3）：乱序插件集仍正确（软约束生效）、
// 五服务缺席 fail-closed、失败自清理、最小世界端到端跑一轮。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import { textScript } from "@x-harness/testkit";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { createAgentWorld, inlineSessionKit, llmKit, loopKit, meterKit, promptKit, toolboxKit } from "../index.ts";

let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

const AGENT = { model: "m", provider: "fake" };

describe("createAgentWorld + kits（F1）", () => {
  it("最小世界端到端：乱序数组（meter 在 prompt 前、toolbox 在 systemPrompt 前）仍正确装配并跑一轮", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-"));
    const gate = new PathGate(root);
    const env = createLocalEnv(root);
    const plugins: readonly Plugin[] = [
      ...meterKit(),
      ...toolboxKit({ root, gate, env }), // 数组序在 promptKit 之前——softInject 拉正
      ...inlineSessionKit(),
      ...llmKit([{ name: "fake", stream: () => textScript("kit-hello") }]),
      ...promptKit(),
      ...loopKit(),
    ];
    const world = await createAgentWorld({ plugins });
    expect(world.ok).toBe(true);
    if (!world.ok) throw new Error(world.reason);
    const made = await world.value.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    const joined = (event: { data: unknown }): string =>
      ((event.data as { content?: readonly { type: string; text?: string }[] }).content ?? []).map((b) => (b as { text?: string }).text ?? "").join("");
    const texts = made.value.agent.session.events().filter((e) => e.type === "assistant/message").map(joined);
    expect(texts).toEqual(["kit-hello"]);
    expect(world.value.registry.schemas().map((s) => s.name)).toContain("bash"); // toolbox 装齐
    await world.value.ctx.dispose();
  });

  it("五服务缺席 → fail-closed（ok:false + 自清理）", async () => {
    const result = await createAgentWorld({ plugins: [systemPromptPlugin] }); // 无 session/loop/tools/meter
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not provided/);
  });

  it("坏插件 throw → 自清理（dispose 后无悬挂）", async () => {
    const bad: Plugin = { name: "bad", apply: () => { throw new Error("boom"); } };
    const result = await createAgentWorld({ plugins: [bad, ...inlineSessionKit()] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("boom");
  });

  it("toolboxKit 缺省接线：gate/observed 内包（read/write 共享实例）", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-2"));
    const plugins: readonly Plugin[] = [
      ...inlineSessionKit(),
      ...toolboxKit({ root, env: createLocalEnv(root) }),
    ];
    const ctx = createContext();
    const unload = await loadPlugins(ctx, plugins);
    expect(ctx.use((await import("@x-harness/tools")).toolRegistry).schemas().map((s) => s.name)).toEqual(["read", "write", "bash", "grep", "task_output", "task_stop"]);
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });
});
