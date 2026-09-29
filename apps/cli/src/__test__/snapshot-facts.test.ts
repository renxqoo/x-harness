import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintSessionId } from "@x-harness/session";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { localToday, renderDateSnapshot } from "@x-harness/harness";
import { buildWorld } from "../build-world.ts";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";
import { createTerminalBrokerPlugin } from "../broker-terminal.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "xh-snap-"));
  dirs = [...dirs, dir];
  return dir;
};

const CONFIG = (() => {
  const parsed = parseProvidersConfig({
    providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["m1"] }],
  });
  if (!parsed.ok) throw new Error("fixture invalid");
  const resolved = resolveModel(parsed.value, {});
  if (!resolved.ok) throw new Error("fixture invalid");
  return { config: parsed.value, resolution: resolved.value };
})();

function captureAdapter(captured: LlmRequest[], turns: number): LlmAdapter {
  return {
    name: "glm",
    stream: (request) => {
      captured.push(request);
      void turns;
      return (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "text-delta", text: `reply-${String(captured.length)}` };
        yield { type: "finish", finish: { kind: "stop" } };
      })();
    },
  };
}

describe("注入级旅程（buildWorld 真装配——A/C' 通道端到端）", () => {
  it("指令+日期快照注入/合并序/落位（快照在锚点前、请求体携带）；改文件重注入、假钟跨天新条、锚点零 replace；旧锚点迁移恰一次 replace", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "agents instructions v1");
    writeFileSync(join(dir, "CLAUDE.md"), "claude instructions");
    let clockMs = Date.UTC(2026, 8, 21, 12);
    const captured: LlmRequest[] = [];
    const built = await buildWorld({
      mainSessionId: mintSessionId(),

      mailboxRoot: join(dir, "mailbox"),


      workflowDir: join(dir, "workflows"),

      cwd: dir,
      sessionRoot: join(dir, "sessions"),
      persist: false,
      config: CONFIG.config,
      resolution: CONFIG.resolution,
      broker: createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) }),
      adapters: [captureAdapter(captured, 5)],
      factsNow: () => clockMs,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const world = built.value;
    const made = await world.loop.create({ agent: { model: "m1" } });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const handle = made.value;
    const systemCount = (): number => handle.agent.session.events().filter((e) => e.type === "system/message").length;
    const userTexts = (): string[] => {
      const out: string[] = [];
      for (const event of handle.agent.session.events()) {
        if (event.type !== "user/message") continue;
        for (const block of (event.data as unknown as { content: Array<{ type: string; text: string }> }).content) {
          if (block.type === "text") out.push(block.text);
        }
      }
      return out;
    };
    try {
      handle.agent.followup("one");
      await handle.agent.whenIdle();
      const texts = userTexts();
      const day = localToday(new Date(clockMs));
      expect(texts.some((t) => t === renderDateSnapshot(new Date(clockMs)))).toBe(true);
      expect(texts.some((t) => t.includes("agents instructions v1") && t.includes("claude instructions") && t.includes('<snapshot kind="project-instructions">'))).toBe(true);
      expect(texts.some((t) => t.includes(day))).toBe(true);
      const surface = handle.agent.session.surface();
      const anchorIndex = surface.findIndex((n) => n.event.type === "system/message");
      expect(anchorIndex).toBeGreaterThan(0);
      for (const node of surface.slice(0, anchorIndex)) expect(node.event.type === "user/message");
      const afterAnchor = surface[anchorIndex + 1]?.event.data as unknown as { content?: Array<{ text?: string }> };
      expect(afterAnchor.content?.[0]?.text).toBe("one");
      expect(JSON.stringify(captured[0]?.messages)).toContain("agents instructions v1");
      expect(JSON.stringify(captured[0]?.messages)).toContain("claude instructions");
      expect(systemCount()).toBe(1);

      writeFileSync(join(dir, "AGENTS.md"), "agents instructions v2");
      handle.agent.followup("two");
      await handle.agent.whenIdle();
      const afterEdit = userTexts();
      expect(afterEdit.some((t) => t.includes("agents instructions v2"))).toBe(true);
      expect(afterEdit.some((t) => t.includes("agents instructions v1"))).toBe(true);
      expect(afterEdit.filter((t) => t.includes("claude instructions")).length).toBeGreaterThanOrEqual(2);
      expect(systemCount()).toBe(1);

      clockMs += 24 * 3_600_000;
      handle.agent.followup("three");
      await handle.agent.whenIdle();
      const nextDay = localToday(new Date(clockMs));
      expect(nextDay).not.toBe(day);
      expect(userTexts().some((t) => t.includes(nextDay))).toBe(true);
      expect(systemCount()).toBe(1);
      await handle.dispose();
    } finally {
      await world.ctx.dispose().catch(() => {});
    }

    const dir2 = makeDir();
    const clockMs2 = Date.UTC(2026, 8, 22, 12);
    const captured2: LlmRequest[] = [];
    const built2 = await buildWorld({
      mainSessionId: mintSessionId(),

      mailboxRoot: join(dir2, "mailbox"),


      workflowDir: join(dir2, "workflows"),

      cwd: dir2,
      sessionRoot: join(dir2, "sessions"),
      persist: false,
      config: CONFIG.config,
      resolution: CONFIG.resolution,
      broker: createTerminalBrokerPlugin({ interactive: false, write: () => {}, question: () => Promise.resolve(undefined) }),
      adapters: [captureAdapter(captured2, 2)],
      factsNow: () => clockMs2,
    });
    expect(built2.ok).toBe(true);
    if (!built2.ok) return;
    const world2 = built2.value;
    const made2 = await world2.loop.create({ agent: { model: "m1" } });
    expect(made2.ok).toBe(true);
    if (!made2.ok) return;
    const handle2 = made2.value;
    try {
      const seeded = handle2.agent.session.append("system/message", { turn: 0, step: 0, text: "old anchor with Today's date: 2026-09-20 baked in" }, { surfaceOp: "append" });
      expect(seeded.ok).toBe(true);
      handle2.agent.followup("one");
      await handle2.agent.whenIdle();
      const systemEvents = handle2.agent.session.events().filter((e) => e.type === "system/message");
      expect(systemEvents).toHaveLength(2);
      expect(systemEvents[1]?.surfaceOp).toMatchObject({ op: "replace" });
      handle2.agent.followup("two");
      await handle2.agent.whenIdle();
      expect(handle2.agent.session.events().filter((e) => e.type === "system/message")).toHaveLength(2);
      await handle2.dispose();
    } finally {
      await world2.ctx.dispose().catch(() => {});
    }
  });
});
