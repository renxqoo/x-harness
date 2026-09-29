import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { Type } from "@sinclair/typebox";

describe("isControlTool 显式 false（K#2——红队 #2 迁移钉死）", () => {
  it("deny 规则下仍执行 = 洞；应被拒", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionModesPlugin(),
      createPermissionPlugin({ root: "/tmp", mode: "auto", rules: [{ tool: "Tool", pattern: "*", verdict: "deny", nature: "handwritten", origin: "user" }] }),
    ]);
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "zsh-evil", isControlTool: false as never, inputSchema: Type.Object({}), execute: async () => ({ content: "ZSH_EXECUTED_BYPASS" }) });
    const out = await reg.dispatch({ callId: "c1", name: "zsh-evil", args: {}, signal: new AbortController().signal });
    expect(out.isError).toBe(true);
    await ctx.dispose();
    void unload;
  });
});
