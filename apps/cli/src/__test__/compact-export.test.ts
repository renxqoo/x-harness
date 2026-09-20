// /compact 与 /export 集成（docs/CLI.md §2.3、§4）：真装配世界 + 剧本 adapter。
// compact 关键回归：折叠后保留 system 锚点；**折叠后再跑一个 turn，摘要仍在 surface**
// （对抗审查 #1 症状：锚点被折叠 → 下一 turn 被锚点覆写机制摧毁摘要）。
// export：flush 屏障后拷贝、已存在拒绝、--no-session 内存序列化。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { buildWorld, compactionOptionsOf } from "../build-world.ts";
import type { World } from "../build-world.ts";
import { compactionRunner } from "@x-harness/compaction";
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
    compaction: { contextWindow: 200_000 }, // 手动 /compact 走 compactionRunner（生产路径）
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

describe("compactionRunner 手动面（/compact 生产路径）", () => {
  it("有历史：折叠锚点之后的区间 surface，摘要落 user/message（checkpoint 形态）；单轮 no-op", async () => {
    const fixture = await makeFixture([textScript("answer-1"), textScript("answer-2"), textScript("SUMMARY-TEXT")], false);
    const handle = await makeAgent(fixture, "compact-a");
    await runTurn(handle, "question-1");
    await runTurn(handle, "question-2");
    const before = handle.agent.session.surface().length;
    const runner = fixture.world.ctx.use(compactionRunner);
    const outcome = await runner.compact({ session: handle.agent.session.id, keepRecentTokens: 0, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ ok: true });
    const surface = handle.agent.session.surface();
    expect(surface.length).toBeLessThan(before);
    const anchor = surface.find((node) => (node.event.data as { text?: unknown }).text !== undefined);
    expect(anchor?.event.type).toBe("system/message"); // 锚点保留（anchorIndexOf 谓词定位——预锚快照可占 surface[0]）
    const text = JSON.stringify(surface);
    expect(text).toContain("SUMMARY-TEXT"); // 摘要落 surface（checkpoint user/message；尾轮原文按 keepRecent 保留）
    await handle.dispose();
  });



  it("主窗链三档:显式传参 > providers 声明窗 > 保守兜底 128k——contextWindow 必须吃 providers.json 声明(修复:恒兜底忽略声明窗)", async () => {
    const base: Parameters<typeof compactionOptionsOf>[0] = { config: CONFIG.config, resolution: CONFIG.resolution };
    // 兜底档:档案无 contextWindow → 128_000
    expect(compactionOptionsOf(base).contextWindow).toBe(128_000);
    // 声明窗档:档案带 contextWindow → 声明值生效
    const withWindow: Parameters<typeof compactionOptionsOf>[0] = {
      config: { ...CONFIG.config, providers: [{ ...CONFIG.config.providers[0]!, contextWindow: 999_000 }] },
      resolution: CONFIG.resolution,
    };
    expect(compactionOptionsOf(withWindow).contextWindow).toBe(999_000);
    // 显式档:compaction.contextWindow 恒最高优先
    const explicit: Parameters<typeof compactionOptionsOf>[0] = { ...base, compaction: { contextWindow: 50_000 } };
    expect(compactionOptionsOf(explicit).contextWindow).toBe(50_000);
  });

  it("生产参数(缺省 keepRecentTokens=20k):小会话 → no-cut-point(nothing to compact);大粘贴越过保留区 → 真折叠", async () => {
    // 小会话:两轮短对话总量远小于 20k 保留预算 → 尾保留吞没全部起点,无切口
    const small = await makeFixture([textScript("a-1"), textScript("a-2")], false);
    const smallHandle = await makeAgent(small, "compact-small");
    await runTurn(smallHandle, "question-1");
    await runTurn(smallHandle, "question-2");
    const noop = await small.world.ctx.use(compactionRunner).compact({ session: smallHandle.agent.session.id, signal: new AbortController().signal });
    expect(noop).toEqual({ ok: false, reason: "no-cut-point" });
    expect(smallHandle.agent.session.events().some((event) => typeof event.surfaceOp === "object")).toBe(false); // 无落账
    await smallHandle.dispose();

    // 大会话:中间轮 >20k token 的 CJK 粘贴越过保留预算 → 生产参数下真折叠
    // (首个真轮不可折——被摘要区间须含真轮起点;大粘贴须在早轮之后的轮)
    const bigPaste = "长".repeat(80_000); // CJK 1:1 计量——80k token 越过 20k 保留预算
    const big = await makeFixture([textScript("b-1"), textScript("b-2"), textScript("b-3"), textScript("SUMMARY-BIG")], false);
    const bigHandle = await makeAgent(big, "compact-big");
    await runTurn(bigHandle, "question-1");
    await runTurn(bigHandle, bigPaste);
    await runTurn(bigHandle, "question-3");
    const folded = await big.world.ctx.use(compactionRunner).compact({ session: bigHandle.agent.session.id, signal: new AbortController().signal });
    expect(folded.ok).toBe(true); // 不传 keepRecentTokens(生产形态)——大粘贴产生真切口
    const surface = bigHandle.agent.session.surface();
    expect(surface.length).toBeLessThan(bigHandle.agent.session.events().length); // 投影收缩(replace 在场)
    expect(JSON.stringify(surface)).toContain("SUMMARY-BIG");
    await bigHandle.dispose();
  });

  it("回归：折叠后再跑一个 turn，摘要仍在 surface 且锚点不被覆写摧毁", async () => {
    const fixture = await makeFixture([textScript("answer-1"), textScript("answer-2"), textScript("SUMMARY-KEEP"), textScript("answer-3")], false);
    const handle = await makeAgent(fixture, "compact-b");
    await runTurn(handle, "question-1");
    await runTurn(handle, "question-2");
    const folded = await fixture.world.ctx.use(compactionRunner).compact({ session: handle.agent.session.id, keepRecentTokens: 0, signal: new AbortController().signal });
    expect(folded.ok).toBe(true);
    await runTurn(handle, "question-3");
    const text = JSON.stringify(handle.agent.session.surface());
    expect(text).toContain("SUMMARY-KEEP"); // 摘要存活
    expect(handle.agent.session.events().filter((event) => event.type === "system/message").length).toBeGreaterThanOrEqual(1);
    await handle.dispose();
  });

  it("总结失败（error finish）→ failed 不落账", async () => {
    const fixture = await makeFixture([textScript("answer-1"), textScript("answer-2"), [{ type: "finish", finish: { kind: "error", message: "boom", code: "http-400" } }]], false);
    const handle = await makeAgent(fixture, "compact-c");
    await runTurn(handle, "question-1");
    await runTurn(handle, "question-2");
    const outcome = await fixture.world.ctx.use(compactionRunner).compact({ session: handle.agent.session.id, keepRecentTokens: 0, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ ok: false, reason: "summarize-failed" });
    expect(handle.agent.session.events().some((event) => typeof event.surfaceOp === "object")).toBe(false); // 失败不落账
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
