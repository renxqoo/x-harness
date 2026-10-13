import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import type { World } from "./world.ts";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, makeOptions, resetWorlds, sessionOf } from "./world.ts";

const modelOf = (event: { readonly data: unknown } | undefined): string | undefined =>
  event === undefined ? undefined : (event.data as { model?: string }).model;

const providerOf = (event: { readonly data: unknown } | undefined): string | undefined =>
  event === undefined ? undefined : (event.data as { provider?: string } | undefined)?.provider;

const eventsOf = (world: World, session: SessionId): readonly ReturnType<Session["events"]>[number][] => {
  const found = world.ctx.use(sessionStore).get(session);
  return found === undefined ? [] : found.events();
};

const childEnded = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "turn/end");

beforeEach(() => {
  resetWorlds();
});

describe("拨号门禁症状回归（跨渠道重名模型被静默换掉）", () => {
  const dualOwnerCatalog = {
    dialable: (ref: string) => ref === "GLM/glm-5.3-flash" || ref === "GLM/glm-5.3" || ref === "other/glm-5.3-flash" || ref === `fake/${PARENT_MODEL}` || ref === "fake/bare-ok",
    resolveProviderOf: (model: string) => (model === PARENT_MODEL || model === "bare-ok" ? "fake" : undefined),
  };

  it("症状：类型 md 声明 provider+重名裸模型（GLM/glm-5.3-flash 拆解后）拨声明拨号——不再被裸名门禁丢弃换父模型", async () => {
    const options = await makeOptions({ explore: { model: "GLM/glm-5.3-flash", body: "you search" } });
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    world.scripts.set("glm-5.3-flash", [textScript("glm-5.3-flash", "found it")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "explore" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const header = eventsOf(world, childSession).find((e) => e.type === "request/header");
    expect(modelOf(header)).toBe("glm-5.3-flash");
    expect(providerOf(header)).toBe("GLM");
    await parent.dispose();
  });

  it("症状：spawn.model 裸名经父 provider 解析后可拨则放行——白名单刻意不含裸名 parent-model，旧裸名预检会误拒", async () => {
    const options = await makeOptions({});
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    parent.agent.followup("warm");
    await parent.agent.whenIdle();
    const bare = await callTool({ world, name: "agent_spawn", args: { description: "bare", prompt: "x", model: PARENT_MODEL }, session: parent.agent.session.id });
    expect(bare.isError).toBeUndefined();
    const bareSession = sessionOf(bare.content);
    await vi.waitFor(() => expect(childEnded(world, bareSession)).toBe(true), { timeout: 5_000 });
    const bareHeader = eventsOf(world, bareSession).find((e) => e.type === "request/header");
    expect(modelOf(bareHeader)).toBe(PARENT_MODEL);
    expect(providerOf(bareHeader)).toBe("fake");
    await parent.dispose();
  });

  it("spawn.model 复合串直接拨对应 provider（跨渠道重名裸名的无歧义路径）", async () => {
    const options = await makeOptions({});
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    world.scripts.set("glm-5.3-flash", [textScript("glm-5.3-flash", "c")]);
    const composite = await callTool({ world, name: "agent_spawn", args: { description: "comp", prompt: "x", model: "other/glm-5.3-flash" }, session: parent.agent.session.id });
    expect(composite.isError).toBeUndefined();
    const compositeSession = sessionOf(composite.content);
    await vi.waitFor(() => expect(childEnded(world, compositeSession)).toBe(true), { timeout: 5_000 });
    const compositeHeader = eventsOf(world, compositeSession).find((e) => e.type === "request/header");
    expect(modelOf(compositeHeader)).toBe("glm-5.3-flash");
    expect(providerOf(compositeHeader)).toBe("other");
    await parent.dispose();
  });

  it("类型裸名（无 provider 字段）目录反查归属可拨放行；反查不到硬拒", async () => {
    const ok = await makeOptions({ scout: { model: "bare-ok", body: "scout" } });
    const worldOk = await makeWorld({ ...ok, ...dualOwnerCatalog });
    const parentOk = await spawnParent(worldOk);
    worldOk.scripts.set("bare-ok", [textScript("bare-ok", "ok")]);
    const spawned = await callTool({ world: worldOk, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "scout" }, session: parentOk.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(worldOk, childSession)).toBe(true), { timeout: 5_000 });
    const header = eventsOf(worldOk, childSession).find((e) => e.type === "request/header");
    expect(modelOf(header)).toBe("bare-ok");
    expect(providerOf(header)).toBe("fake");
    await parentOk.dispose();

    const bad = await makeOptions({ scout: { model: "ghost-bare", body: "scout" } });
    const worldBad = await makeWorld({ ...bad, ...dualOwnerCatalog });
    const parentBad = await spawnParent(worldBad);
    worldBad.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    parentBad.agent.followup("warm");
    await parentBad.agent.whenIdle();
    const degraded = await callTool({ world: worldBad, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "scout" }, session: parentBad.agent.session.id });
    expect(degraded.isError).toBeUndefined();
    const degradedSession = sessionOf(degraded.content);
    await vi.waitFor(() => expect(childEnded(worldBad, degradedSession)).toBe(true), { timeout: 5_000 });
    expect(modelOf(eventsOf(worldBad, degradedSession).find((e) => e.type === "request/header"))).toBe(PARENT_MODEL);
    await parentBad.dispose();
  });

  it("spawn.model 真不可拨 → 硬拒，报文携带解析后的复合 ref 与 provider/model 引导", async () => {
    const options = await makeOptions({});
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    const denied = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", model: "ghost-model" }, session: parent.agent.session.id });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("model 'ghost-model' resolves to dial 'fake/ghost-model'");
    expect(denied.content).toContain("'provider/model' reference");
    await parent.dispose();
  });

  it("类型声明不可拨（部署配置面）→ 降级父拨号且不静默（症状原发面的持久披露见快照）", async () => {
    const options = await makeOptions({ explore: { model: "GLM/ghost-model", body: "you search" } });
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    parent.agent.followup("warm");
    await parent.agent.whenIdle();
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "explore" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const header = eventsOf(world, childSession).find((e) => e.type === "request/header");
    expect(modelOf(header)).toBe(PARENT_MODEL);
    await parent.dispose();
  });

  it("override × 类型 provider 同场：最终拨号 ref 参与校验，不可拨即拒（不再串出未校验的 GLM/ghost-model）", async () => {
    const options = await makeOptions({ explore: { model: "GLM/glm-5.3-flash", body: "you search" } });
    const world = await makeWorld({ ...options, ...dualOwnerCatalog });
    const parent = await spawnParent(world);
    const denied = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "explore", model: "ghost-model" }, session: parent.agent.session.id });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("model 'ghost-model' resolves to dial 'GLM/ghost-model'");
    await parent.dispose();
  });

  it("持久披露：类型模型不可拨时快照如实标注（宣称与实际不再矛盾）", async () => {
    const { renderTypesBlock } = await import("../plugin.ts");
    const types = {
      explore: { name: "explore", description: "search", model: "ghost-model", provider: "GLM", prompt: "" },
      worker: { name: "worker", description: "work", model: "glm-5.3-flash", provider: "GLM", prompt: "" },
    };
    const body = renderTypesBlock(types, dualOwnerCatalog.dialable, dualOwnerCatalog.resolveProviderOf);
    expect(body).toContain("explore — search (model: ghost-model — not dialable in this deployment, falls back to the parent dial)");
    expect(body).toContain("worker — work (model: glm-5.3-flash)");
    const ungated = renderTypesBlock(types);
    expect(ungated).toContain("explore — search (model: ghost-model)");
  });
});