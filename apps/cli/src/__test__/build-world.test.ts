// build-world 冒烟（docs/CLI.md §2.5/§4）：全量装配可起、服务可 use、工具面在册、
// --no-session 条件化、adapter 构造与 --api-key 绑定。假 adapter 注入（不出网）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { llmRuntime } from "@x-harness/llm";
import { buildAdapters, buildWorld, adapterOptionsOf, RETRY_POLICY } from "../build-world.ts";
import type { World } from "../build-world.ts";
import type { ProvidersConfig } from "../providers-file.ts";
import type { ModelResolution } from "../resolve-model.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";
import type { BrokerIO } from "../broker-terminal.ts";

/** 模块级解包：失败即抛，后续拿到的是已收窄的值（闭包内不做 Result 窄化） */
function unwrapped(): { readonly config: ProvidersConfig; readonly resolution: ModelResolution } {
  const parsed = parseProvidersConfig({
    providers: [
      { name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k1", models: ["glm-4.7"] },
      { name: "ovt", protocol: "openai", baseUrl: "https://b", apiKey: "k2", models: ["qwen3"] },
    ],
    default: { provider: "glm", model: "glm-4.7", thinking: "low" },
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture resolution invalid");
  return { config: parsed.value, resolution: resolved.value };
}
const { config: CONFIG, resolution: RESOLUTION } = unwrapped();

function fakeAdapter(name: string): LlmAdapter {
  const stream = function (request: LlmRequest): AsyncIterable<LlmChunk> {
    void request;
    return (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "finish", finish: { kind: "stop" } };
    })();
  };
  return { name, stream };
}

const brokerIO: BrokerIO = {
  interactive: false,
  write: () => {},
  question: () => Promise.resolve(undefined),
};

let roots: string[] = [];
let worlds: World[] = [];
beforeEach(() => {
  roots = [];
  worlds = [];
});
afterEach(async () => {
  for (const world of worlds) await world.ctx.dispose().catch(() => {});
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makeWorld(over: { persist?: boolean } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "xh-world-"));
  roots.push(root);
  const built = await buildWorld({
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist: over.persist ?? true,
    config: CONFIG,
    resolution: RESOLUTION,
    broker: createTerminalBrokerPlugin(brokerIO),
    adapters: CONFIG.providers.map((profile) => fakeAdapter(profile.name)),
  });
  if (!built.ok) throw new Error(`buildWorld failed: ${built.reason}`);
  worlds.push(built.value);
  return built.value;
}

describe("buildWorld 全量装配冒烟", () => {
  it("服务面可 use：store/archive/loop/prompt/meter/registry；adapter 已注册", async () => {
    const world = await makeWorld();
    expect(world.store).toBeDefined();
    expect(world.archive).toBeDefined();
    expect(world.loop).toBeDefined();
    expect(world.prompt).toBeDefined();
    expect(world.meter).toBeDefined();
    const names = world.registry.schemas().map((schema) => schema.name);
    for (const tool of ["read", "write", "bash", "grep", "task_output", "task_stop", "agent_spawn", "list_agents", "agent_message"]) {
      expect(names).toContain(tool);
    }
    // fake adapter 按档案名注册（provider 解析键 = adapter 名）
    const runtime = world.ctx.use(llmRuntime);
    expect(runtime).toBeDefined();
  });

  it("persist=false（--no-session）：archive 缺席（tryUse undefined），其余服务不受影响", async () => {
    const world = await makeWorld({ persist: false });
    expect(world.archive).toBeUndefined();
    expect(world.loop).toBeDefined();
  });
});

describe("buildAdapters", () => {
  it("每档案一个 adapter，name = 档案名（provider 解析键）", () => {
    const adapters = buildAdapters(CONFIG, RESOLUTION);
    expect(adapters.map((adapter) => adapter.name)).toEqual(["glm", "ovt"]);
  });

  it("--api-key 只折进绑定档案（apiKeyProvider）", () => {
    const withKey = resolveModel(CONFIG, { model: "qwen3", apiKey: "sk-override" });
    if (!withKey.ok) throw new Error("fixture invalid");
    const override = withKey.value.defaults.apiKey !== undefined ? withKey.value.apiKeyProvider : undefined;
    const options = CONFIG.providers.map((profile) => adapterOptionsOf(profile, profile.name === override ? withKey.value.defaults.apiKey ?? profile.apiKey : profile.apiKey));
    expect(options[0]).toMatchObject({ name: "glm", apiKey: "k1" });
    expect(options[1]).toMatchObject({ name: "ovt", apiKey: "sk-override" });
  });

  it("RETRY_POLICY 缺省策略落档值（jitterRatio 契约整数）", () => {
    expect(RETRY_POLICY).toEqual({ maxRetries: 3, initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0 });
  });
});
