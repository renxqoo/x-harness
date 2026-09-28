// 红测（adversarial——b85e043 plan 模式实现对抗审查，CLI 宿主面）：
//
// 1) `--permission plan` 启动形态（build-world.ts defaultPermissionOf → planKit
//    liftTo="plan"）：plan_submit 被批准后返回 "plan mode lifted"，但 mode.set("plan")
//    是空操作——write 仍吃 plan 硬闸，模型被告知可实施却被拒（死锁+谎言）。
//    不变量：plan_submit 批准后，装配缺省档为 plan 的世界里 write 必须放行。
// 2) /plan toggle（run-repl.ts makePermissionCommands：target = defaultMode）：
//    `--permission plan` 时 defaultMode === "plan"，从 plan 档 toggle 的目标仍是
//    plan——切不出 plan 档，文案还宣告 "plan mode OFF"。
//    不变量：已在 plan 档时 /plan toggle 必须切到非 plan 档。
// 3) 终端 broker 确认条无会话区分（broker-terminal.ts askWith 忽略 input.session）：
//    委派共享 world 里子代理的 plan_submit 问询与主会话不可分辨。
//    不变量：带 session 的 ask，提示行必须含该会话标识。
//
// 修好后应绿；当前实现下以下用例为红。

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

// 旅程不跑 LLM turn——adapter 只为装配在场，被调即测试装置错误
const NULL_ADAPTER: LlmAdapter = {
  name: "glm",
  stream: (_request: LlmRequest) => {
    throw new Error("plan journey does not stream");
  },
};

// 交互式 broker 自动批准（用户点 y）
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

/** 主会话 id（owner 锚——与生产 main.ts 的 create({ session: { id: mainSessionId } }) 同形态） */
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
    // 现状证据锚：批准通过且宣告解档（当前实现如此返回）
    expect(submit.isError).toBeUndefined();
    expect(submit.content).toContain("Plan approved");
    expect(submit.content).toContain("lifted");
    // 不变量：批准后 plan 档必须真的解除——界内 write 放行
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

// broker 会话区分红测已撤（对抗审查裁决）：blast radius 在工具层关死——depth>0 会话
// 的 plan_submit 直接拒绝（delegated-session），broker 永远收不到子会话 ask，确认条
// 无需会话标识。通用「ask 载荷 session 的宿主展示面」另案低优先级（ConfirmFields
// 无 session 字段——真出现多源 ask 再立项）。
