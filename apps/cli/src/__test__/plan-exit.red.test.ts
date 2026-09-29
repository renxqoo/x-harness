import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { permissionMode } from "@x-harness/permission";
import { toolsPlugin } from "@x-harness/tools";
import { createPlanSubmitPlugin } from "@x-harness/tool-plan";
import type { LlmAdapter, LlmRequest } from "@x-harness/llm";
import { mintSessionId } from "@x-harness/session";
import { makePermissionCommands } from "../run-repl.ts";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseCliArgs } from "../parse-cli-args.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

const MAIN_ID = mintSessionId();

const NULL_ADAPTER: LlmAdapter = {
  name: "glm",
  stream: (_request: LlmRequest) => {
    throw new Error("plan-exit journey does not stream");
  },
};

const APPROVE_BROKER = createTerminalBrokerPlugin({ interactive: true, write: () => {}, question: async () => "y" });

describe("可达性：--permission plan 是合法启动姿势", () => {
  it("parseCliArgs 接受 --permission plan（PROFILE_IDS 词表含 plan）", () => {
    const parsed = parseCliArgs(["--permission", "plan", "-p", "hi"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.permission).toBe("plan");
  });
});

describe("/plan toggle（slash 面——planControl 路由 + 插件层 liftTo 规范化）", () => {
  async function rig(initial: string, liftTo: string): Promise<{ readonly toggle: () => string; readonly mode: () => string }> {
    const ctx = createContext();
    let current = initial;
    await loadPlugins(ctx, [
      toolsPlugin,
      createPlanSubmitPlugin({ liftTo: liftTo as never }),
      { name: "fake-mode", apply: (c) => c.provide(permissionMode, { get: () => current, set: (n: string) => { current = n; } }) },
    ]);
    const world = { ctx } as unknown as World;
    const handle = { agent: { session: { id: "main-1" } } } as never;
    return { toggle: makePermissionCommands(() => ({ world, handle })).planToggle, mode: () => current };
  }

  it("缺省启动：plan ↔ sandboxed-auto 双向可达", async () => {
    const r = await rig("sandboxed-auto", "sandboxed-auto");
    expect(r.toggle()).toContain("plan mode ON");
    expect(r.mode()).toBe("plan");
    expect(r.toggle()).toContain("plan mode OFF");
    expect(r.mode()).toBe("sandboxed-auto");
  });

  it("--permission plan 启动：/plan 可退出 plan 档（liftTo 误配 plan → 插件层回退 auto——不落单向门/假解档）", async () => {
    const r = await rig("plan", "plan");
    const text = r.toggle();
    expect(r.mode()).not.toBe("plan");
    expect(text).toContain("plan mode OFF");
  });
});

describe("plan_submit liftTo（工具面——病灶 2）", () => {
  const roots: string[] = [];
  const worlds: World[] = [];
  afterEach(async () => {
    for (const world of worlds.splice(0)) await world.ctx.dispose().catch(() => {});
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("--permission plan 装配 + 用户批准：plan_submit 应解档（红——liftTo 即 plan，set 为 no-op）", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-planexit-"));
    roots.push(root);
    const built = await buildWorld({
      mainSessionId: MAIN_ID,
      mailboxRoot: join(root, "mailbox"),
      workflowDir: join(root, "workflows"),
      cwd: root,
      sessionRoot: join(root, "sessions"),
      persist: false,
      config: CONFIG.config,
      resolution: CONFIG.resolution,
      permission: "plan",
      broker: APPROVE_BROKER,
      adapters: [NULL_ADAPTER],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.reason);
    const world = built.value;
    worlds.push(world);
    const svc = world.ctx.tryUse(permissionMode);
    expect(svc).toBeDefined();
    expect(svc?.get()).toBe("plan");
    const made = await world.loop.create({ session: { id: MAIN_ID }, agent: { model: "m1" } });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const out = await world.registry.dispatch({
      callId: "planexit-1",
      name: "plan_submit",
      args: { plan: "step 1: read the parser; step 2: refactor it" },
      signal: new AbortController().signal,
      session: made.value.agent.session.id,
    });
    expect(out.isError).not.toBe(true);
    expect(String(out.content)).toContain("plan mode lifted");
    expect(svc?.get()).not.toBe("plan");
  });
});
