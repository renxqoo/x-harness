import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScriptWorker, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptWorker } from "./kit/worker-harness.ts";

const workers: Array<{ input: ScriptWorker["input"] }> = [];

afterAll(async () => {
  for (const w of workers) w.input.end();
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
});

describe("meta 桥接设置链（症状：thinkingFallback 误报 project / permissionModeSource 恒 default）", () => {
  it("settings 配 thinking.default（user）→ get_thinking_level source=user（非误报 project）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "meta-fallback-"));
    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "hub-settings.json"), JSON.stringify({ "thinking.default": "low" }), "utf8");
      const w = await spawnScriptWorker({
        script: [{ reply: "ok" }],
        agentDir,
      });
      workers.push({ input: w.input });
      w.send({ type: "thread/start", id: "s1", cwd: agentDir });
      const started = await waitResponse(w.captured.lines, "thread/start", "s1");
      expect(started.success).toBe(true);
      w.send({ type: "get_thinking_level", id: "q1", threadId: (started.data as { threadId: string }).threadId });
      const level = await waitResponse(w.captured.lines, "get_thinking_level", "q1");
      expect((level.data as { level?: string }).level).toBe("low");
      expect((level.data as { source?: string }).source).toBe("user");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("settings 配 permission.defaultMode（user）→ permission/get_mode source=user（非恒 default）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "meta-mode-"));
    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "hub-settings.json"), JSON.stringify({ "permission.defaultMode": "plan" }), "utf8");
      const w = await spawnScriptWorker({
        script: [{ reply: "ok" }],
        agentDir,
      });
      workers.push({ input: w.input });
      w.send({ type: "thread/start", id: "s1", cwd: agentDir });
      const started = await waitResponse(w.captured.lines, "thread/start", "s1");
      expect(started.success).toBe(true);
      w.send({ type: "permission/get_mode", id: "q1", threadId: (started.data as { threadId: string }).threadId });
      const mode = await waitResponse(w.captured.lines, "permission/get_mode", "q1");
      expect((mode.data as { source?: string }).source).toBe("user");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }, 30_000);
});
