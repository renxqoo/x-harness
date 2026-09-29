import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { createPermissionPlugin, permissionBroker, permissionMode } from "@x-harness/permission";
import { createPermissionModesPlugin } from "@x-harness/permission-modes";
import type { AskPayload, AskReply } from "@x-harness/permission";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPlanSubmitPlugin } from "../plugin.ts";

const EXEC = (): { callId: string; name: string; signal: AbortSignal; session: never } => ({
  callId: "c1",
  name: "plan_submit",
  signal: new AbortController().signal,
  session: "s1" as never,
});

interface Fixture {
  readonly mode: { current: string };
  readonly asks: AskPayload[];
  verdict: "allow" | "deny";
}

function fakePermissionPlugin(fixture: Fixture): Plugin {
  return {
    name: "fake-permission",
    apply: (ctx) => {
      const offMode = ctx.provide(permissionMode, {
        get: () => fixture.mode.current,
        set: (next: string) => {
          fixture.mode.current = next;
        },
      });
      const offBroker = ctx.provide(permissionBroker, {
        ask: async (payload: AskPayload): Promise<AskReply> => {
          fixture.asks.push(payload);
          return { verdict: fixture.verdict };
        },
      });
      return () => {
        offMode();
        offBroker();
      };
    },
  };
}

function hangingBrokerPlugin(): { plugin: Plugin; asks: AskPayload[]; allow: () => void } {
  const asks: AskPayload[] = [];
  let release: ((reply: AskReply) => void) | undefined;
  const plugin: Plugin = {
    name: "hanging-broker",
    apply: (ctx) =>
      ctx.provide(permissionBroker, {
        ask: (payload: AskPayload): Promise<AskReply> => {
          asks.push(payload);
          return new Promise<AskReply>((resolve) => {
            release = resolve;
          });
        },
      }),
  };
  return { plugin, asks, allow: () => release?.({ verdict: "allow" }) };
}

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i += 1) {
    await new Promise((r) => {
      setTimeout(r, 1);
    });
  }
}

async function toolOf(plugins: readonly Plugin[]) {
  const ctx = createContext();
  await loadPlugins(ctx, plugins);
  const tool = ctx.use(toolRegistry).get("plan_submit");
  if (tool === undefined) throw new Error("plan_submit not registered");
  return tool;
}

describe("plan_submit 审批不变量（红测）", () => {
  describe("liftTo === 装配缺省 plan 档（CLI --permission plan 形态）", () => {
    it("批准后必须真正离开 plan 档——当前 mode.set(\"plan\") 空操作仍锁档", async () => {
      const fixture: Fixture = { mode: { current: "plan" }, asks: [], verdict: "allow" };
      const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ liftTo: "plan", mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
      await tool.execute({ plan: "refactor in three steps" }, EXEC());
      expect(fixture.mode.current).not.toBe("plan");
    });

    it("liftTo:\"plan\" 视为误配回退 auto——文案如实宣告实际档位（不谎报 lifted）", async () => {
      const fixture: Fixture = { mode: { current: "plan" }, asks: [], verdict: "allow" };
      const tool = await toolOf([toolsPlugin, createPlanSubmitPlugin({ liftTo: "plan", mainSession: "s1" as never }), fakePermissionPlugin(fixture)]);
      const out = await tool.execute({ plan: "refactor in three steps" }, EXEC());
      expect(fixture.mode.current).toBe("auto");
      expect(out.content).toContain("plan mode lifted (permission mode: auto)");
    });
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function planWorld(): Promise<{ ctx: Context; disposers: readonly Disposer[]; svc: { get(): string }; broker: ReturnType<typeof hangingBrokerPlugin> }> {
  const root = await mkdtemp(join(tmpdir(), "xh-planred-"));
  roots.push(root);
  const broker = hangingBrokerPlugin();
  const ctx = createContext();
  const disposers = await loadPlugins(ctx, [
    createPermissionModesPlugin(),
    toolsPlugin,
    createPlanSubmitPlugin({ mainSession: "s1" as never }),
    createPermissionPlugin({ root, mode: "plan" }),
    broker.plugin,
  ]);
  const svc = ctx.use(permissionMode);
  if (svc.get() !== "plan") throw new Error("fixture invalid: expected plan mode");
  return { ctx, disposers, svc, broker };
}

describe("拆卸/取消窗口（真实 permission 插件 + 挂起 broker）", () => {
  it("world 拆卸后迟到的 allow 不得解档（对齐 permission 插件 tearingDown 丢弃语义）", async () => {
    const { ctx, disposers, svc, broker } = await planWorld();
    const tool = ctx.use(toolRegistry).get("plan_submit");
    if (tool === undefined) throw new Error("missing plan_submit");
    const pending = tool.execute({ plan: "x" }, EXEC());
    await waitUntil(() => broker.asks.length === 1);
    for (const dispose of disposers) await dispose();
    broker.allow();
    const out = await pending;
    expect(svc.get()).toBe("plan");
    expect(out.isError === true || !out.content.includes("lifted")).toBe(true);
  });

  it("turn 取消（exec.signal abort）后迟到的 allow 不得解档", async () => {
    const { ctx, svc, broker } = await planWorld();
    const tool = ctx.use(toolRegistry).get("plan_submit");
    if (tool === undefined) throw new Error("missing plan_submit");
    const controller = new AbortController();
    const pending = tool.execute({ plan: "x" }, { callId: "c1", name: "plan_submit", signal: controller.signal, session: "s1" as never });
    await waitUntil(() => broker.asks.length === 1);
    controller.abort();
    broker.allow();
    await pending;
    expect(svc.get()).toBe("plan");
  });
});
