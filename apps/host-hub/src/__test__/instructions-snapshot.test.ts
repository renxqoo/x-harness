import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScriptWorker, waitEvent, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptWorker } from "./kit/worker-harness.ts";

const dirs: string[] = [];
const workspaces: string[] = [];
const workers: ScriptWorker[] = [];
afterAll(async () => {
  for (const w of workers) w.input.end();
  await Promise.all([...dirs.map((dir) => rm(dir, { recursive: true, force: true })), ...workspaces.map((dir) => rm(dir, { recursive: true, force: true }))]);
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
});

async function spawnInWorkspace(): Promise<{ w: ScriptWorker; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "hub-instr-"));
  workspaces.push(cwd);
  const w = await spawnScriptWorker({ script: [{ reply: "ok" }, { reply: "ok" }] });
  workers.push(w);
  return { w, cwd };
}

describe("项目指令快照（worker 装配与 CLI 同源——@x-harness/harness createFactsSnapshotPlugin）", () => {
  test("注入 + 合并序（AGENTS 前）+ 请求携带；改文件重注入；缺席零注入", async () => {
    const { w, cwd } = await spawnInWorkspace();
    await writeFile(join(cwd, "AGENTS.md"), "hub agents rules", "utf8");
    await writeFile(join(cwd, "CLAUDE.md"), "hub claude notes", "utf8");
    w.send({ type: "thread/start", id: "s1", cwd });
    const started = await waitResponse(w.captured.lines, "thread/start", "s1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "question" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "get_messages", id: "gm1", threadId });
    const messages = await waitResponse(w.captured.lines, "get_messages", "gm1");
    const texts = JSON.stringify(messages.data);
    expect(texts).toContain("project-instructions");
    const agentsAt = texts.indexOf("hub agents rules");
    const claudeAt = texts.indexOf("hub claude notes");
    expect(agentsAt).toBeGreaterThan(-1);
    expect(claudeAt).toBeGreaterThan(agentsAt);
    expect(texts).toContain("date");

    await writeFile(join(cwd, "AGENTS.md"), "hub agents rules v2", "utf8");
    w.send({ type: "prompt", id: "p2", threadId, message: "again" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p2");
    w.send({ type: "get_messages", id: "gm2", threadId });
    const afterEdit = JSON.stringify((await waitResponse(w.captured.lines, "get_messages", "gm2")).data);
    expect(afterEdit).toContain("hub agents rules v2");

    const bare = await spawnInWorkspace();
    bare.w.send({ type: "thread/start", id: "s1", cwd: bare.cwd });
    const bareStarted = await waitResponse(bare.w.captured.lines, "thread/start", "s1");
    expect(bareStarted.success).toBe(true);
    const bareThread = (bareStarted.data as { threadId: string }).threadId;
    bare.w.send({ type: "prompt", id: "p1", threadId: bareThread, message: "hi" });
    await waitEvent(bare.w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    bare.w.send({ type: "get_messages", id: "gm1", threadId: bareThread });
    const bareTexts = JSON.stringify((await waitResponse(bare.w.captured.lines, "get_messages", "gm1")).data);
    expect(bareTexts).not.toContain("project-instructions");
    expect(bareTexts).toContain("date");
  }, 20_000);
});
