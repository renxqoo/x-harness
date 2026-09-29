import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin, permissionDecided } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { createPlanSubmitPlugin } from "../index.ts";
import type { SessionId } from "@x-harness/session";
import type { PermissionAudit } from "@x-harness/permission";

const ROOT = "/w/plan-posture";

describe("planMode 覆盖的面补齐（注册表 decide + 旋钮 posture——facesOf 结构修）", () => {
  it("plan 档（planKit 在场）界内 Read → allow in-root（非 ask/outside-root）", async () => {
    const ctx = createContext();
    const audits: PermissionAudit[] = [];
    const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionModesPlugin(), createPermissionPlugin({ root: ROOT, mode: "plan" }), createPlanSubmitPlugin({ liftTo: "auto" })]);
    ctx.on(permissionDecided, (a) => audits.push(a));
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "read", kind: "Read", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    const out = await reg.dispatch({ callId: "pp-1", name: "read", args: { path: "src/a.ts" }, signal: new AbortController().signal, session: "s1" as SessionId });
    expect(out.isError).not.toBe(true);
    expect(out.content).toBe("ran");
    expect(audits[0]).toMatchObject({ tool: "read", verdict: "allow", resolvedBy: "auto", reason: "in-root" });
    await ctx.dispose();
    void unload;
  });

  it("plan 档富策略自持面不回归：bash 只读 allow / bash 写 deny / write deny", async () => {
    const ctx = createContext();
    const audits: PermissionAudit[] = [];
    const unload = await loadPlugins(ctx, [toolsPlugin, createPermissionModesPlugin(), createPermissionPlugin({ root: ROOT, mode: "plan" }), createPlanSubmitPlugin({ liftTo: "auto" })]);
    ctx.on(permissionDecided, (a) => audits.push(a));
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "bash", kind: "Danger", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    reg.register({ name: "write", kind: "Write", inputSchema: Type.Object({}), execute: async () => ({ content: "ran" }) });
    await reg.dispatch({ callId: "pp-b1", name: "bash", args: { command: "ls" }, signal: new AbortController().signal, session: "s1" as SessionId });
    await reg.dispatch({ callId: "pp-b2", name: "bash", args: { command: "npm install" }, signal: new AbortController().signal, session: "s1" as SessionId });
    await reg.dispatch({ callId: "pp-w", name: "write", args: { path: "a.ts", content: "x" }, signal: new AbortController().signal, session: "s1" as SessionId });
    expect(audits[0]).toMatchObject({ verdict: "allow", resolvedBy: "classifier:readonly" });
    expect(audits[1]?.verdict).toBe("deny");
    expect(audits[2]).toMatchObject({ verdict: "deny", resolvedBy: "mode:plan" });
    await ctx.dispose();
    void unload;
  });
});
