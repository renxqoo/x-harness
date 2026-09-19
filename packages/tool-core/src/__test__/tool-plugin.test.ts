// 工具插件工厂测试（docs/TOOLBOX.md §0）：env 三级解析缺席/根错配 fail-closed（此前全仓
// 零覆盖的两条装配期 throw）、注册/卸载往返、observed 在场挂 sessionDisposed 逐出、
// 缺席不挂（bash/grep 形态）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolDefinition } from "@x-harness/tools";
import { createLocalEnv } from "@x-harness/exec-env";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { PathGate, ObservedRegistry, createToolPlugin } from "../index.ts";
import type { FileVersion } from "../index.ts";
import { createBasePromptPlugin, systemPrompt, systemPromptPlugin } from "@x-harness/system-prompt";
import type { BasePromptFacts } from "@x-harness/system-prompt";

let root: string;
let gate: PathGate;
let observed: ObservedRegistry;

const version: FileVersion = { ino: "1", size: "1", mtimeNs: "1", hadBom: false };

/** 最小可 dispatch 工具（工厂契约只关心 ToolDefinition 形状，不关心语义） */
const probe = (): ToolDefinition => ({
  name: "probe",
  description: "probe",
  inputSchema: Type.Object({}),
  execute: async () => ({ content: "probe-ok" }),
});

const dispatchProbe = async (): Promise<void> => {
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe() })]);
  const reg = ctx.use(toolRegistry);
  const r = await reg.dispatch({ callId: "p1", name: "probe", args: {}, signal: new AbortController().signal });
  expect(r.content).toBe("probe-ok");
  for (const dispose of unload) await dispose();
  const gone = await reg.dispatch({ callId: "p2", name: "probe", args: {}, signal: new AbortController().signal });
  expect(gone.isError).toBe(true); // 卸载后工具不可达
  await ctx.dispose();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-tp-"));
  gate = new PathGate(root);
  observed = new ObservedRegistry();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createToolPlugin（docs/TOOLBOX.md §0——装配期 fail-closed）", () => {
  it("env 三级解析全缺席 → 装配期 throw（工厂参数 > execEnv 服务 > throw）", () => {
    const plugin = createToolPlugin({ name: "tool-probe", gate, make: () => probe() });
    expect(() => plugin.apply(createContext())).toThrow(/tool-probe requires an ExecEnv/);
  });

  it("env.root 与 gate 根错配 → throw（执法面漂移拒绝——审查 F9）", () => {
    const other = mkdtempSync(join(tmpdir(), "xh-tp-other-"));
    try {
      const plugin = createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(other), make: () => probe() });
      expect(() => plugin.apply(createContext())).toThrow(/does not match gate root/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("注册/卸载往返：装载后可 dispatch，拆卸后不可达", async () => {
    await dispatchProbe();
  });

  it("observed 在场：sessionDisposed 逐出该会话观察桶", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, observed, envOption: createLocalEnv(root), make: () => probe() }),
    ]);
    const made = await ctx.use(sessionStore).create({ id: "s-evict" as never });
    expect(made.ok).toBe(true);
    observed.record("s-evict" as never, join(gate.root, "a.txt"), version);
    expect(observed.lookup("s-evict" as never, join(gate.root, "a.txt"))).toBeDefined();
    const disposed = ctx.use(sessionStore).dispose("s-evict" as never);
    expect(disposed.ok).toBe(true);
    expect(observed.lookup("s-evict" as never, join(gate.root, "a.txt"))).toBeUndefined(); // 会话终结即逐出
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("observed 缺席（bash/grep 形态）：不挂逐出，会话终结后工具仍可用（无越权生命周期耦合）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      sessionPlugin,
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe() }),
    ]);
    const reg = ctx.use(toolRegistry);
    const made = await ctx.use(sessionStore).create({ id: "s-plain" as never });
    expect(made.ok).toBe(true);
    const disposed = ctx.use(sessionStore).dispose("s-plain" as never);
    expect(disposed.ok).toBe(true);
    const after = await reg.dispatch({ callId: "p-after", name: "probe", args: {}, signal: new AbortController().signal });
    expect(after.content).toBe("probe-ok"); // 会话生命周期与工具注册无耦合
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("attach 生命周期：Disposer 随插件拆卸执行", async () => {
    let torn = 0;
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(), attach: () => () => { torn += 1; } }),
    ]);
    expect(torn).toBe(0);
    for (const dispose of unload) await dispose();
    expect(torn).toBe(1);
    await ctx.dispose();
  });
});

describe("guidance 纯数据位（组合层桥接——本包不认识 prompt）", () => {
  it("guidance 落 ToolDefinition：registry.get 可读；缺席为 undefined", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(), guidance: "## Probe\n\nprobe rule" }),
    ]);
    expect(ctx.use(toolRegistry).get("probe")?.guidance).toBe("## Probe\n\nprobe rule");
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("函数形 guidance 接收解析后 env（配置感知）；空串解析不落 def", async () => {
    const ctx = createContext();
    const seenKinds: string[] = [];
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createToolPlugin({
        name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(),
        guidance: (env) => { seenKinds.push(env.kind); return env.kind === "sandbox" ? "fence rule" : ""; },
      }),
    ]);
    const reg = ctx.use(toolRegistry);
    expect(seenKinds).toEqual(["local"]);
    expect(reg.get("probe")?.guidance).toBeUndefined(); // 非 sandbox → 空串 → 不落 def
    const r = await reg.dispatch({ callId: "p1", name: "probe", args: {}, signal: new AbortController().signal });
    expect(r.content).toBe("probe-ok"); // 工具行为与 guidance 无耦合
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("guidance 不进 schemas()（LLM 序列化面无此字段）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(), guidance: "secret-guidance" }),
    ]);
    const schema = ctx.use(toolRegistry).schemas().find((s) => s.name === "probe");
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).not.toContain("secret-guidance");
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("投稿停靠（D6 序）：guidance + system-prompt 在场 → section tool/<name>（锚 base/core，Output Format 之后）；拆卸回收", async () => {
    const ctx = createContext();
    const facts: BasePromptFacts = { cwd: "/w", isGit: false, platform: "darwin", shell: "zsh", date: "2026-09-20" };
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      createBasePromptPlugin(facts),
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(), guidance: "## Probe\n\nprobe rule" }),
    ]);
    const prompt = ctx.use(systemPrompt);
    const text = prompt.assemble().text;
    expect(text).toContain("probe rule");
    expect(text.indexOf("## Output Format")).toBeLessThan(text.indexOf("## Probe")); // 锚 base/core：基础段末尾之后
    for (const dispose of unload) await dispose();
    expect(prompt.assemble().text).not.toContain("probe rule"); // 拆卸即回收（disposer 链先于 prompt 服务回卷）
    await ctx.dispose();
  });

  it("投稿停靠：空串 guidance（如 local env 的 bash）不注册段——assemble 无 tool/ 段", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      systemPromptPlugin,
      toolsPlugin,
      createToolPlugin({ name: "tool-probe", gate, envOption: createLocalEnv(root), make: () => probe(), guidance: () => "" }),
    ]);
    expect(ctx.use(systemPrompt).assemble().text).toBe("");
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });
});
