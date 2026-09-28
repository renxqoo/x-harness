// 红测（对抗审查——b85e043 宿主面）：/plan 与 plan_submit 的「退不出 plan」双病灶。
//
// 病灶 1（slash 面）：runRepl 把装配缺省档传成 args.permission ?? "sandboxed-auto"
// （run-repl.ts:354）。当 CLI 以 --permission plan 启动（parse-cli-args 词表允许——
// PROFILE_IDS 含 plan），defaultMode === "plan"，makePermissionCommands 的 toggle
// 目标恒等于当前档：plan → plan。/plan 变成只进不出的单向门，且文案谎称
// "plan mode ON"（用户意图是 OFF）。
//
// 病灶 2（工具面）：build-world planKit({ liftTo: defaultPermissionOf(options) })
// （build-world.ts:236）——options.permission === "plan" 时 liftTo === "plan"，
// plan_submit 批准后 mode.set("plan") 是 no-op，但工具回文宣称
// "plan mode lifted ... Proceed with the implementation"。模型随即尝试写入，
// 又被 plan-deny 拒——审批协议件在最需要它的启动姿势下失效。
//
// 本文件断言「应该能退出」——现状为红即坐实设计 bug。

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

/** 主会话 id（owner 锚——与生产 main.ts 的 create({ session: { id: mainSessionId } }) 同形态） */
const MAIN_ID = mintSessionId();

const NULL_ADAPTER: LlmAdapter = {
  name: "glm",
  stream: (_request: LlmRequest) => {
    throw new Error("plan-exit journey does not stream");
  },
};

/** 批准面 broker：一切 ask → allow-once（用户批准方案的交互面替身） */
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
      permission: "plan", // 病灶触发条件
      broker: APPROVE_BROKER,
      adapters: [NULL_ADAPTER],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.reason);
    const world = built.value;
    worlds.push(world);
    const svc = world.ctx.tryUse(permissionMode);
    expect(svc).toBeDefined();
    expect(svc?.get()).toBe("plan"); // 装配起点：plan
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
    expect(out.isError).not.toBe(true); // broker 批准路径本身通（绿）
    expect(String(out.content)).toContain("plan mode lifted"); // 现状：回文宣称已解档（欺骗面）
    expect(svc?.get()).not.toBe("plan"); // 红——实际档位仍为 "plan"
  });
});
