// 日期 + 项目指令快照（docs/TAIL-SNAPSHOT-CHANNEL.md A/C'）：日期假钟按天幂等/跨天
// 新条、指令合并序（AGENTS.md 前）/同内容去重/缺席零注入/64KB 上限以 buffer 长度
// 为准（超限整文件拒注+告警）。

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_SUPERSEDES, isSnapshotNode } from "@x-harness/agent-loop";
import type { SurfaceNode } from "@x-harness/session";
import type { LlmAdapter, LlmChunk, LlmRequest } from "@x-harness/llm";
import { INSTRUCTIONS_CAP_BYTES, localToday, readInstructionFiles, renderDateSnapshot } from "../snapshot-facts.ts";
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

const at = (iso: string): Date => new Date(iso);

describe("日期快照（A）", () => {
  it("信封 kind=date + 作废声明；同日幂等（render 全文唯一）、跨日新条——UTC 正午锚点（任意机器时区同判）", () => {
    const noon = at("2026-09-21T12:00:00Z");
    const day1 = renderDateSnapshot(noon);
    expect(day1).toContain('<snapshot kind="date">');
    expect(day1).toContain(SNAPSHOT_SUPERSEDES);
    expect(day1).toContain(`Today's date: ${localToday(noon)} (`);
    expect(localToday(noon)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(renderDateSnapshot(new Date(noon.getTime() + 30 * 60_000))).toBe(day1); // 同日（+30min 不跨任何时区民事日界；−30 在 UTC-12 会跨日，勿照注补负向断言）
    expect(renderDateSnapshot(new Date(noon.getTime() + 24 * 3_600_000))).not.toBe(day1); // 跨日新条
  });

  it("isSnapshotNode 对日期快照消息形态成立（跨包谓词闭环）", () => {
    const node = { seq: 0, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: renderDateSnapshot(at("2026-09-21T10:00:00+08:00")) }] } } } as unknown as SurfaceNode;
    expect(isSnapshotNode(node)).toBe(true);
  });
});

describe("项目指令读取（C'）", () => {
  it("缺席零注入（无文件 → body 空串）", () => {
    const dir = makeDir();
    expect(readInstructionFiles(dir).body).toBe("");
    expect(readInstructionFiles(dir).warnings).toEqual([]);
  });

  it("合并序：AGENTS.md 在前、CLAUDE.md 在后，以 --- 分隔", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "CLAUDE.md"), "claude body");
    writeFileSync(join(dir, "AGENTS.md"), "agents body");
    expect(readInstructionFiles(dir).body).toBe("agents body\n---\n\nclaude body");
  });

  it("同内容去重：软链/复制形态只注一份", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "same body");
    symlinkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
    expect(readInstructionFiles(dir).body).toBe("same body");
  });

  it("64KB 上限以读到 buffer 长度为准：超限整文件拒注+告警，另一文件照常（TOCTOU 面不可黑盒测——stat 预判与 buffer 判定在确定性夹具下等价，本用例不区分二者）", () => {
    const dir = makeDir();
    const big = Buffer.alloc(INSTRUCTIONS_CAP_BYTES + 1, 0x61);
    writeFileSync(join(dir, "AGENTS.md"), big);
    writeFileSync(join(dir, "CLAUDE.md"), "small");
    const read = readInstructionFiles(dir);
    expect(read.body).toBe("small");
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("AGENTS.md");
    expect(read.warnings[0]).toContain("skipped");
  });

  it("读取失败分流：ENOENT 静默、其余 IO 错误告警跳过（fail-open 可见——不与缺席同路吞掉）", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "secret", { mode: 0o000 }); // 属主无读权限 → EACCES
    const read = readInstructionFiles(dir);
    expect(read.body).toBe("");
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("AGENTS.md");
    expect(read.warnings[0]).toContain("unreadable");
    const absent = readInstructionFiles(join(dir, "nope"));
    expect(absent.body).toBe("");
    expect(absent.warnings).toEqual([]); // ENOENT 静默
  });
});

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
    let clockMs = Date.UTC(2026, 8, 21, 12); // UTC 正午锚点（时区可移植）
    const captured: LlmRequest[] = [];
    const built = await buildWorld({
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
      expect(texts.some((t) => t === renderDateSnapshot(new Date(clockMs)))).toBe(true); // 日期快照（假钟当日）
      expect(texts.some((t) => t.includes("agents instructions v1") && t.includes("claude instructions") && t.includes('<snapshot kind="project-instructions">'))).toBe(true); // 合并序 AGENTS 前
      expect(texts.some((t) => t.includes(day))).toBe(true);
      const surface = handle.agent.session.surface();
      // 预锚落位（不钉快照条数——agents 目录在场性随机器变）：system 锚点之前全是快照 user/message，
      // 锚点之后紧接本轮 user 批次
      const anchorIndex = surface.findIndex((n) => n.event.type === "system/message");
      expect(anchorIndex).toBeGreaterThan(0);
      for (const node of surface.slice(0, anchorIndex)) expect(node.event.type).toBe("user/message");
      expect((surface[anchorIndex + 1]?.event.data as unknown as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe("one");
      expect(JSON.stringify(captured[0]?.messages)).toContain("agents instructions v1"); // 本轮请求即携带
      expect(JSON.stringify(captured[0]?.messages)).toContain("claude instructions");
      expect(systemCount()).toBe(1); // 锚点恰一条（首 kick 落锚）

      writeFileSync(join(dir, "AGENTS.md"), "agents instructions v2");
      handle.agent.followup("two");
      await handle.agent.whenIdle();
      const afterEdit = userTexts();
      expect(afterEdit.some((t) => t.includes("agents instructions v2"))).toBe(true); // 变更重注入
      expect(afterEdit.some((t) => t.includes("agents instructions v1"))).toBe(true); // 旧条在场（历史不改写）
      expect(afterEdit.filter((t) => t.includes("claude instructions")).length).toBeGreaterThanOrEqual(2); // 新旧快照都带 CLAUDE 体
      expect(systemCount()).toBe(1); // 指令变更零 replace（症状：易变事实变化致全前缀失效）

      clockMs += 24 * 3_600_000; // 假钟跨天
      handle.agent.followup("three");
      await handle.agent.whenIdle();
      const nextDay = localToday(new Date(clockMs));
      expect(nextDay).not.toBe(day);
      expect(userTexts().some((t) => t.includes(nextDay))).toBe(true); // 跨天新条
      expect(systemCount()).toBe(1); // 日期翻天零 replace（同症状锚）
      await handle.dispose();
    } finally {
      await world.ctx.dispose().catch(() => {});
    }

    // 迁移锚：旧式锚点（铸着日期）→ 首轮恰一次 replace → 之后稳定
    const dir2 = makeDir();
    const clockMs2 = Date.UTC(2026, 8, 22, 12);
    const captured2: LlmRequest[] = [];
    const built2 = await buildWorld({
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
      expect(systemEvents).toHaveLength(2); // 旧锚点 + 恰一次 replace
      expect(systemEvents[1]?.surfaceOp).toMatchObject({ op: "replace" });
      handle2.agent.followup("two");
      await handle2.agent.whenIdle();
      expect(handle2.agent.session.events().filter((e) => e.type === "system/message")).toHaveLength(2); // 之后稳定
      await handle2.dispose();
    } finally {
      await world2.ctx.dispose().catch(() => {});
    }
  });
});
