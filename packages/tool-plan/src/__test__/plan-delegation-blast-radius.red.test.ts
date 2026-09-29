import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { createPermissionPlugin, permissionBroker } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import type { AskPayload } from "@x-harness/permission";
import { toolsPlugin, toolRegistry, defineTool } from "@x-harness/tools";
import { createPlanSubmitPlugin } from "../plugin.ts";

const PROBE_WRITE: Plugin = {
  name: "probe-write",
  inject: ["tools"],
  apply: (ctx) =>
    ctx.use(toolRegistry).register(
      defineTool({
        name: "write",
        kind: "Write",
        inputSchema: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async () => ({ content: "wrote" }),
      }),
    ),
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function sharedWorld(): Promise<{ root: string; asks: AskPayload[]; dispatch: (session: string, name: string, args: unknown) => Promise<{ content: string; isError?: true }>; planSubmit: (session: string) => Promise<{ content: string; isError?: true }> }> {
  const root = await mkdtemp(join(tmpdir(), "xh-planblast-"));
  roots.push(root);
  const asks: AskPayload[] = [];
  const brokerPlugin: Plugin = {
    name: "recording-broker",
    apply: (ctx) =>
      ctx.provide(permissionBroker, {
        ask: async (payload: AskPayload) => {
          asks.push(payload);
          return { verdict: "allow" };
        },
      }),
  };
  const ctx = createContext();
  await loadPlugins(ctx, [
    createPermissionModesPlugin(),
    toolsPlugin,
    createPlanSubmitPlugin({ liftTo: "auto", mainSession: "main-session" as never }),
    createPermissionPlugin({ root, mode: "plan" }),
    brokerPlugin,
    PROBE_WRITE,
  ]);
  const registry = ctx.use(toolRegistry);
  let seq = 0;
  return {
    root,
    asks,
    dispatch: (session, name, args) => registry.dispatch({ callId: `blast-${String(seq += 1)}`, name, args, signal: new AbortController().signal, session: session as never }),
    planSubmit: async (session) => {
      const tool = registry.get("plan_submit");
      if (tool === undefined) throw new Error("missing plan_submit");
      return tool.execute({ plan: "child agent plan" }, { callId: "plan-c1", name: "plan_submit", signal: new AbortController().signal, session: session as never });
    },
  };
}

describe("委派子代理共享 world 的解档爆炸半径（红测）", () => {
  it("非 owner 会话 plan_submit 被拒（not-plan-owner）——broker 不触、plan 硬闸不动；owner 批准照常解档", async () => {
    const w = await sharedWorld();
    const main = "main-session";
    const child = "child-session";

    const before = await w.dispatch(main, "write", { path: join(w.root, "a.txt"), content: "x" });
    expect(before.isError).toBe(true);
    expect(before.content).toContain("plan mode disallows write");

    const out = await w.planSubmit(child);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not-plan-owner");
    expect(w.asks).toEqual([]);
    const after = await w.dispatch(main, "write", { path: join(w.root, "b.txt"), content: "x" });
    expect(after.isError).toBe(true);

    const mainOut = await w.planSubmit(main);
    expect(mainOut.content).toContain("approved");
    const post = await w.dispatch(main, "write", { path: join(w.root, "c.txt"), content: "x" });
    expect(post.isError).toBeUndefined();
  });
});
