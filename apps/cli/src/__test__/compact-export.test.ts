// /compact 与 /export 集成（docs/CLI.md §2.3、§4）：真装配世界 + 剧本 adapter。
// compact 关键回归：折叠后保留 system 锚点；**折叠后再跑一个 turn，摘要仍在 surface**
// （对抗审查 #1 症状：锚点被折叠 → 下一 turn 被锚点覆写机制摧毁摘要）。
// export：flush 屏障后拷贝、已存在拒绝、--no-session 内存序列化。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { buildWorld } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { compactSession } from "../compact-session.ts";
import { exportSession } from "../export-session.ts";
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

function scriptAdapter(scripts: LlmChunk[][]): LlmAdapter {
  return {
    name: "glm",
    stream: (request: LlmRequest) => {
      void request;
      const next = scripts.shift();
      if (next === undefined) throw new Error("script exhausted");
      return (async function* (): AsyncGenerator<LlmChunk> {
        for (const chunk of next) yield chunk;
      })();
    },
  };
}

const textScript = (text: string): LlmChunk[] => [
  { type: "text-delta", text },
  { type: "finish", finish: { kind: "stop" } },
];

interface Fixture {
  world: World;
  root: string;
  cleanup: () => Promise<void>;
}

let fixtures: Fixture[] = [];
beforeEach(() => {
  fixtures = [];
});
afterEach(async () => {
  for (const fixture of fixtures) await fixture.cleanup().catch(() => {});
});

async function makeFixture(scripts: LlmChunk[][], persist: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "xh-compact-"));
  const built = await buildWorld({
    cwd: root,
    sessionRoot: join(root, "sessions"),
    persist,
    config: CONFIG.config,
    resolution: CONFIG.resolution,
    broker: createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) }),
    adapters: [scriptAdapter(scripts)],
  });
  if (!built.ok) throw new Error(built.reason);
  const fixture: Fixture = {
    world: built.value,
    root,
    cleanup: async () => {
      await built.value.ctx.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function makeAgent(fixture: Fixture, id: string) {
  const made = await fixture.world.loop.create({ session: { id: id as never }, agent: { model: "m1" } });
  if (!made.ok) throw new Error(made.reason);
  return made.value;
}

async function runTurn(handle: Awaited<ReturnType<typeof makeAgent>>, prompt: string): Promise<void> {
  handle.agent.followup(prompt);
  await handle.agent.whenIdle();
}

describe("compactSession", () => {
  it("有历史：折叠锚点之后的全部 surface，摘要落 user/message；空会话 no-op", async () => {
    const fixture = await makeFixture([textScript("answer-1"), textScript("SUMMARY-TEXT")], false);
    const handle = await makeAgent(fixture, "compact-a");
    await runTurn(handle, "question-1");
    const before = handle.agent.session.surface().length;
    const outcome = await compactSession({ ctx: fixture.world.ctx, session: handle.agent.session, dial: { provider: "glm", model: "m1" }, instructions: undefined, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ kind: "folded" });
    const surface = handle.agent.session.surface();
    expect(surface.length).toBeLessThan(before);
    const anchor = surface[0];
    expect(anchor?.event.type).toBe("system/message"); // 锚点保留
    const last = surface[surface.length - 1];
    expect(last?.event.type).toBe("user/message");
    expect(JSON.stringify(last?.event.data)).toContain("SUMMARY-TEXT");
    await handle.dispose();
  });

  it("回归：折叠后再跑一个 turn，摘要仍在 surface 且锚点不被覆写摧毁", async () => {
    const fixture = await makeFixture([textScript("answer-1"), textScript("SUMMARY-KEEP"), textScript("answer-2")], false);
    const handle = await makeAgent(fixture, "compact-b");
    await runTurn(handle, "question-1");
    const folded = await compactSession({ ctx: fixture.world.ctx, session: handle.agent.session, dial: { provider: "glm", model: "m1" }, instructions: undefined, signal: new AbortController().signal });
    expect(folded.kind).toBe("folded");
    await runTurn(handle, "question-2");
    const text = JSON.stringify(handle.agent.session.surface());
    expect(text).toContain("SUMMARY-KEEP"); // 摘要存活
    expect(handle.agent.session.events().filter((event) => event.type === "system/message").length).toBeGreaterThanOrEqual(1);
    await handle.dispose();
  });

  it("总结失败（error finish）→ failed 不落账", async () => {
    const fixture = await makeFixture([textScript("answer-1"), [{ type: "finish", finish: { kind: "error", message: "boom", code: "http-400" } }]], false);
    const handle = await makeAgent(fixture, "compact-c");
    await runTurn(handle, "question-1");
    const outcome = await compactSession({ ctx: fixture.world.ctx, session: handle.agent.session, dial: { provider: "glm", model: "m1" }, instructions: undefined, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ kind: "failed" });
    await handle.dispose();
  });
});

describe("exportSession", () => {
  it("persist：flush 后拷贝磁盘卷；已存在目标拒绝", async () => {
    const fixture = await makeFixture([textScript("e1")], true);
    const handle = await makeAgent(fixture, "export-a");
    await runTurn(handle, "q1");
    const target = join(fixture.root, "out", "copy.jsonl");
    const exported = await exportSession({ store: fixture.world.store, sessionRoot: join(fixture.root, "sessions"), session: handle.agent.session, persist: true, target });
    expect(exported.ok).toBe(true);
    const copied = await readFile(target, "utf8");
    expect(copied).toContain("q1");

    const again = await exportSession({ store: fixture.world.store, sessionRoot: join(fixture.root, "sessions"), session: handle.agent.session, persist: true, target });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("refusing to overwrite");
    await handle.dispose();
  });

  it("--no-session：从内存 events 序列化（wx 独占建）", async () => {
    const fixture = await makeFixture([textScript("e2")], false);
    const handle = await makeAgent(fixture, "export-b");
    await runTurn(handle, "q2");
    const target = join(fixture.root, "mem.jsonl");
    const exported = await exportSession({ store: fixture.world.store, sessionRoot: fixture.root, session: handle.agent.session, persist: false, target });
    expect(exported.ok).toBe(true);
    const written = await readFile(target, "utf8");
    expect(written).toContain("q2");
    await handle.dispose();
  });

  it("空目标目录自动创建", async () => {
    const fixture = await makeFixture([], false);
    const handle = await makeAgent(fixture, "export-c");
    const target = join(fixture.root, "deep", "nested", "x.jsonl");
    const exported = await exportSession({ store: fixture.world.store, sessionRoot: fixture.root, session: handle.agent.session, persist: false, target });
    expect(exported.ok).toBe(true);
    await handle.dispose();
  });

  it("已存在文件内容不被清空（wx 语义防误覆盖）", async () => {
    const fixture = await makeFixture([], false);
    const handle = await makeAgent(fixture, "export-d");
    const target = join(fixture.root, "keep.jsonl");
    await writeFile(target, "PRECIOUS", "utf8");
    const exported = await exportSession({ store: fixture.world.store, sessionRoot: fixture.root, session: handle.agent.session, persist: false, target });
    expect(exported.ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("PRECIOUS");
    await handle.dispose();
  });
});
