// /compact 命令自声明单元（BATCH3-DESIGN §2.3）：注册/拆卸、args→customInstructions、
// busy 双前置（running/并发）、skip 归一词表、成功 data 三元组、run|done 配对落账。
import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { commandsPlugin } from "@x-harness/commands";
import { commandRegistry } from "@x-harness/commands";
import { createCompactionPlugin } from "../plugin.ts";
import { commandCompactPlugin } from "../command-compact.ts";
import { BASE_OPTIONS, seedTurn, sid, textScript } from "./helpers.ts";
import { fakeLlm } from "./helpers.ts";
import { llmRuntime } from "@x-harness/llm";

async function makeCommandWorld() {
  const ctx = createContext();
  const fake = fakeLlm();
  // contextWindow 拉大：COMPACT_KEEP_RECENT_TOKENS(20k) 在 1k 窗口下无切点
  await loadPlugins(ctx, [sessionPlugin, createCompactionPlugin({ ...BASE_OPTIONS, contextWindow: 500_000, reserveTokens: 100 } as never), commandsPlugin, commandCompactPlugin]);
  ctx.provide(llmRuntime, fake.runtime);
  return { ctx, store: ctx.use(sessionStore), llm: fake, registry: ctx.use(commandRegistry) };
}

describe("/compact 自声明（BATCH3 §2.3）", () => {
  it("注册面：list 含 compact；拆卸后消失", async () => {
    const world = await makeCommandWorld();
    try {
      expect(world.registry.list().map((entry) => entry.name)).toEqual(["compact"]);
      expect(world.registry.find("compact")?.description).toBe("Compact the conversation history");
    } finally {
      await world.ctx.dispose();
    }
  });

  it("成功：run|done 配对落账（args 逐字含分隔空白）+ data 三元组 + customInstructions 透传", async () => {
    const world = await makeCommandWorld();
    try {
      const made = await world.store.create({ id: sid("cc") });
      if (!made.ok) throw new Error(made.reason);
      const session = made.value;
      // 大正文：越过 COMPACT_KEEP_RECENT_TOKENS(20k) 才有切点
      for (const turn of [0, 1, 2, 3, 4, 5]) {
        seedTurn(session, { turn, user: "u".repeat(12000), assistant: { text: "a".repeat(12000), usage: { input: 100, output: 5 } } });
      }
      world.llm.scripts.push(textScript("CC-SUM"));
      const execution = await world.registry.execute(session, "/compact focus tests", new AbortController().signal);
      if (execution?.result.kind !== "success") throw new Error(`compact failed: ${JSON.stringify(execution?.result)}`);
      const data = (execution.result as { data: { replacedCount: number; summaryTokens: number; summary: unknown } }).data;
      expect(data.replacedCount).toBeGreaterThan(0);
      expect(data.summaryTokens).toBeGreaterThan(0);
      expect(JSON.stringify(data.summary)).toContain("CC-SUM");
      expect(world.llm.calls[0] && JSON.stringify(world.llm.calls[0].messages)).toContain("focus tests");
      const events = session.events().filter((e) => e.type.startsWith("command/"));
      expect(events.map((e) => e.type)).toEqual(["command/run", "command/done"]);
      expect((events[0] as { data: { name: string; args: string } }).data).toMatchObject({ name: "compact", args: " focus tests" });
      expect((events[1] as { data: { kind: string } }).data.kind).toBe("success");
    } finally {
      await world.ctx.dispose();
    }
  });

  it("skip 归一：上下文太小 → 既有词表串 error（不 throw）", async () => {
    const world = await makeCommandWorld();
    try {
      const made = await world.store.create({ id: sid("tiny") });
      if (!made.ok) throw new Error(made.reason);
      const execution = await world.registry.execute(made.value, "/compact", new AbortController().signal);
      expect(execution?.result).toEqual({ kind: "error", text: "context too small to compact" });
    } finally {
      await world.ctx.dispose();
    }
  });

  it("并发双发：第二发在飞期间 → Compaction already in progress（同步 check-and-set）", async () => {
    const world = await makeCommandWorld();
    try {
      const made = await world.store.create({ id: sid("dup") });
      if (!made.ok) throw new Error(made.reason);
      for (const turn of [0, 1, 2, 3, 4, 5]) {
        seedTurn(made.value, { turn, user: "u".repeat(12000), assistant: { text: "a".repeat(12000), usage: { input: 100, output: 5 } } });
      }
      // 慢摘要脚本：第一发在飞，第二发并发进入
      const slow = (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
        yield { type: "text-delta", text: "slow-sum" };
        yield { type: "finish", finish: { kind: "stop" } };
      })();
      world.llm.scripts.push(slow, textScript("second-sum"));
      const first = world.registry.execute(made.value, "/compact", new AbortController().signal);
      const second = await world.registry.execute(made.value, "/compact", new AbortController().signal);
      expect(second?.result).toEqual({ kind: "error", text: "Compaction already in progress" });
      const settled = await first;
      expect(settled?.result.kind).toBe("success");
    } finally {
      await world.ctx.dispose();
    }
  });
});
