import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { permissionMode } from "@x-harness/permission";
import type { LlmAdapter, LlmRequest } from "@x-harness/llm";
import { mintSessionId } from "@x-harness/session";
import { toolsPlugin } from "@x-harness/tools";
import type { ToolOutcome } from "@x-harness/tools";
import { createPlanSubmitPlugin } from "@x-harness/tool-plan";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";
import { makePermissionCommands } from "../run-repl.ts";

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

const NULL_ADAPTER: LlmAdapter = {
  name: "glm",
  stream: (_request: LlmRequest) => {
    throw new Error("plan journey does not stream");
  },
};

const AUTO_YES_BROKER = createTerminalBrokerPlugin({
  interactive: true,
  write: () => {},
  question: () => Promise.resolve("y"),
});

interface Journey {
  readonly world: World;
  readonly root: string;
  readonly session: string;
  dispatch(name: string, args: unknown): Promise<ToolOutcome>;
}

const roots: string[] = [];
const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.ctx.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const JOURNEY_MAIN_ID = mintSessionId();

async function makeJourney(permission: "plan"): Promise<Journey> {
  const root = await mkdtemp(join(tmpdir(), "xh-planmode-"));
  roots.push(root);
  const built = await buildWorld({
    mainSessionId: JOURNEY_MAIN_ID,
    mailboxRoot: join(root, "mailbox"),
    workflowDir: join(root, "workflows"),
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist: false,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    permission,
    broker: AUTO_YES_BROKER,
    adapters: [NULL_ADAPTER],
  });
  if (!built.ok) throw new Error(`buildWorld failed: ${built.reason}`);
  const world = built.value;
  worlds.push(world);
  const made = await world.loop.create({ session: { id: JOURNEY_MAIN_ID }, agent: { model: "m1" } });
  if (!made.ok) throw new Error(made.reason);
  const session = made.value.agent.session.id;
  let callSeq = 0;
  return {
    world,
    root,
    session,
    dispatch: (name, args) =>
      world.registry.dispatch({ callId: `planmode-${String(callSeq += 1)}`, name, args, signal: new AbortController().signal, session }),
  };
}

describe("--permission plan 启动形态（红测）", () => {
  it("plan_submit 批准宣告 lifted 后，write 必须放行——当前仍被 plan 硬闸拦下", async () => {
    const j = await makeJourney("plan");
    const submit = await j.dispatch("plan_submit", { plan: "step 1: read; step 2: write b.txt; step 3: verify" });
    expect(submit.isError).toBeUndefined();
    expect(submit.content).toContain("Plan approved");
    expect(submit.content).toContain("lifted");
    const write = await j.dispatch("write", { path: join(j.root, "b.txt"), content: "x" });
    expect(write.isError).not.toBe(true);
  });
});

describe("/plan toggle（makePermissionCommands——planControl 路由 + 插件层 liftTo 规范化）", () => {
  async function toggleRig(initial: string, liftTo: string): Promise<{ readonly planToggle: () => string; readonly mode: () => string }> {
    const ctx = createContext();
    let current = initial;
    await loadPlugins(ctx, [
      toolsPlugin,
      createPlanSubmitPlugin({ liftTo: liftTo as never }),
      { name: "fake-mode", apply: (c) => c.provide(permissionMode, { get: () => current, set: (n: string) => { current = n; } }) },
    ]);
    const fakeWorld = { ctx } as unknown as World;
    const handle = { agent: { session: { id: "main-1" } } } as never;
    return { planToggle: makePermissionCommands(() => ({ world: fakeWorld, handle })).planToggle, mode: () => current };
  }

  it("liftTo 误配 plan（--permission plan 形态）：toggle 仍可离开 plan——插件层回退 auto，不落单向门", async () => {
    const r = await toggleRig("plan", "plan");
    const message = r.planToggle();
    expect(r.mode()).not.toBe("plan");
    expect(message).toContain("plan mode OFF");
  });

  it("对照锚（缺省档非 plan）：plan ↔ sandboxed-auto 往返", async () => {
    const r = await toggleRig("plan", "sandboxed-auto");
    r.planToggle();
    expect(r.mode()).toBe("sandboxed-auto");
    r.planToggle();
    expect(r.mode()).toBe("plan");
  });
});
