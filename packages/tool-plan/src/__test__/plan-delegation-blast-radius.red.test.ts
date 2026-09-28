// 红测（adversarial——b85e043 对抗审查 攻击面 2）：委派子代理共享 world。
//
// agent-delegation 子代理与主会话同 world（world.loop/同 ctx），permissionMode 是
// world 级单一服务（packages/permission/src/plugin.ts:64-70——mode 是装配事实非会话
// 事实）。子代理调 plan_submit：broker 问用户（hub 确认条文案 "Approve plan"、CLI
// "allow plan_submit?"——均不带会话区分：ask-confirm-fields.ts 的 ConfirmFields 无
// session 字段；broker-terminal.ts askWith 完全忽略 input.session），批准后
// mode.set(liftTo) 全局生效——主会话的 plan 硬闸被一个子代理的审批拆掉。
//
// 不变量：子会话（委派子代理）的 plan_submit 批准，不得改变其他会话的裁决面
// （或等价地：非根会话不得发起 world 级解档）。当前实现全局生效 → 红。
// 修好后应绿（修法二选一：plan_submit 拒绝非根会话 / mode 按会话域生效——另需宿主
// 确认面补会话身份展示，见 apps/cli 红测 broker 会话可见性）。

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

/** 探针 write 工具（非 control）：复用 "write" 名并自报 kind: "Write"——声明面归 Write 族（V4：映射表已删，
 * plan 档下吃 plan-deny（decide.ts:135）；denied 发生在 preExecute，execute 不可达 */
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
    createPermissionModesPlugin(), // V4 内置模式（base 零策略）
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
    const child = "child-session"; // 委派子代理的 exec.session（agent-delegation 子会话）

    // 对照锚：plan 档下主会话 write 被 plan-deny 拦下
    const before = await w.dispatch(main, "write", { path: join(w.root, "a.txt"), content: "x" });
    expect(before.isError).toBe(true);
    expect(before.content).toContain("plan mode disallows write");

    // 非 owner 会话提交方案 → 拒绝（blast radius 在资格面关死），审批通道不触
    const out = await w.planSubmit(child);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not-plan-owner");
    expect(w.asks).toEqual([]);
    const after = await w.dispatch(main, "write", { path: join(w.root, "b.txt"), content: "x" });
    expect(after.isError).toBe(true); // 硬闸仍在

    // 主会话批准 → 正常解档（限制不影响根会话）
    const mainOut = await w.planSubmit(main);
    expect(mainOut.content).toContain("approved");
    const post = await w.dispatch(main, "write", { path: join(w.root, "c.txt"), content: "x" });
    expect(post.isError).toBeUndefined();
  });
});
