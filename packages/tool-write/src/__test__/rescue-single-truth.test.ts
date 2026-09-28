// 抢救件单真相回归件（P0-2——.adversarial/upper/u05 迁移）：permissionAdjudicate 服务优先。
// 自定义 plan-deny 档下主路径 deny 的写，抢救件同 deny 不物化（旧：静态旋钮面无
// customProfiles 通道 + 盲注册表 → 断代落 auto → 界内 allow 落盘——越权物化两真相）。

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolPayload, TruncatedToolDecision } from "@x-harness/agent-loop";
import { createLocalEnv } from "@x-harness/exec-env";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createTruncatedWriteRescuePlugin } from "../rescue-plugin.ts";
import { createPermissionPlugin } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import { toolsPlugin } from "@x-harness/tools";

let root = "";
let ctx: ReturnType<typeof createContext> | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-rescue-truth-"));
});
afterEach(async () => {
  if (ctx !== undefined) await ctx.dispose().catch(() => {});
  ctx = undefined;
  rmSync(root, { recursive: true, force: true });
});

const SESSION = "sess-truth" as never;
const LONG = "x".repeat(600);

/** 装配：permission（自定义 my-plan 档=plan-deny）+ modes + 抢救件——服务面在场 */
async function dispatchCustomPlan(name: string, args: string): Promise<TruncatedToolDecision> {
  const c = createContext();
  ctx = c;
  const unload = await loadPlugins(c, [
    toolsPlugin,
    createPermissionModesPlugin(),
    createPermissionPlugin({
      root,
      mode: "my-plan",
      customProfiles: [{ id: "my-plan", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" }],
    }),
    createTruncatedWriteRescuePlugin({ gate: new PathGate(root), observed: new ObservedRegistry(), env: createLocalEnv(root), permission: { root } }),
  ]);
  c.effect(() => { for (const off of unload) off(); });
  return c.dispatch(agentTruncatedTool, { session: SESSION, turn: 1, step: 1, callId: "c1", name, arguments: args, signal: new AbortController().signal } as TruncatedToolPayload, async () => undefined);
}

describe("rescue × permissionAdjudicate 单真相（P0-2）", () => {
  it("自定义 plan-deny 档：主路径 deny 的写 → 抢救同 deny，不物化 .partial（旧：auto 兜底落盘）", async () => {
    const r = await dispatchCustomPlan("write", `{"path":"doc.md","content":"${LONG}`);
    expect(r).toMatchObject({ note: "target not permitted for rescue write, draft not saved" });
    expect(existsSync(join(root, "doc.md.partial"))).toBe(false); // 越权物化通道封死
  });
  it("auto 档（对照）：界内写经服务面 allow → 照常物化——单真相不收紧正常面", async () => {
    const c = createContext();
    ctx = c;
    const unload = await loadPlugins(c, [
      (await import("@x-harness/tools")).toolsPlugin,
      createPermissionModesPlugin(),
      createPermissionPlugin({ root, mode: "auto" }),
      createTruncatedWriteRescuePlugin({ gate: new PathGate(root), observed: new ObservedRegistry(), env: createLocalEnv(root), permission: { root } }),
    ]);
    c.effect(() => { for (const off of unload) off(); });
    const r = await c.dispatch(agentTruncatedTool, { session: SESSION, turn: 1, step: 1, callId: "c1", name: "write", arguments: `{"path":"doc.md","content":"${LONG}`, signal: new AbortController().signal } as TruncatedToolPayload, async () => undefined);
    expect(r).toMatchObject({ note: expect.stringContaining("Recovered") });
    expect(existsSync(join(root, "doc.md.partial"))).toBe(true);
  });
});
