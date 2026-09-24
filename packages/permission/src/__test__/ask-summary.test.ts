// ask 目标描述（AskPayload.summary）：构造优先序 path → command → pattern，垃圾入参缺席
// 降级；插件级贯通（症状回归：审批确认文案只有 unknown tool:edit，确认方无从得知要改哪个文件）。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin } from "../plugin.ts";
import { permissionBroker } from "../tokens.ts";
import type { AskPayload } from "../types.ts";
import { summaryOf } from "../ask-summary.ts";

describe("summaryOf（目标描述构造）", () => {
  it("优先序 path → command → pattern；非字符串/空串跳过", () => {
    expect(summaryOf({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(summaryOf({ path: "src/a.ts", command: "ls" })).toBe("src/a.ts");
    expect(summaryOf({ command: "npm test" })).toBe("npm test");
    expect(summaryOf({ pattern: "TODO" })).toBe("TODO");
    expect(summaryOf({ path: "", command: "ls" })).toBe("ls");
    expect(summaryOf({ path: 42, pattern: "TODO" })).toBe("TODO");
  });

  it("垃圾入参/无目标标识 → undefined（调用方省略字段，不发空壳）", () => {
    expect(summaryOf({})).toBeUndefined();
    expect(summaryOf({ url: "https://x" })).toBeUndefined();
    expect(summaryOf({ path: 42 })).toBeUndefined();
    expect(summaryOf(null)).toBeUndefined();
    expect(summaryOf("path")).toBeUndefined();
    expect(summaryOf(undefined)).toBeUndefined();
  });
});

describe("ask 载荷带目标描述（插件级贯通）", () => {
  async function asksOf(name: string, args: unknown): Promise<AskPayload[]> {
    const ctx = createContext();
    const asks: AskPayload[] = [];
    const broker: Plugin = {
      name: "test-broker",
      apply: (c) =>
        c.provide(permissionBroker, {
          ask: async (input) => {
            asks.push(input);
            return { verdict: "deny" };
          },
        }),
    };
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionPlugin({ root: "/w/app", mode: "edit-confirm" }),
      broker,
    ]);
    const reg = ctx.use(toolRegistry);
    const off = reg.register({ name, inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    await reg.dispatch({ callId: "c1", name, args, signal: new AbortController().signal });
    off();
    for (const d of unload) await d();
    return asks;
  }

  it("症状回归：edit 审批只见 unknown tool:edit、不知要改哪个文件——ask 载荷现带 summary=路径", async () => {
    const asks = await asksOf("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ tool: "edit", summary: "src/a.ts" });
  });

  it("命令类目标 summary=命令；无目标标识工具 summary 缺席（不发空壳）", async () => {
    const commandLike = await asksOf("webfetch", { command: "npm test" });
    expect(commandLike[0]?.summary).toBe("npm test");
    const bare = await asksOf("mystery", { x: 1 });
    expect(bare[0]?.summary).toBeUndefined();
  });
});
