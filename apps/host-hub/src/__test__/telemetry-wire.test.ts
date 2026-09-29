import { afterAll, describe, expect, test } from "vitest";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnScriptWorker, waitEvent, waitResponse } from "./kit/worker-harness.ts";
import type { ScriptWorker } from "./kit/worker-harness.ts";
import { createTelemetryPurge, telemetryDbPathOf } from "../host/telemetry-purge.ts";
import { createBunSqliteExecutor, createQueryService, ensureSchema } from "@x-harness/telemetry-sqlite";

const workers: ScriptWorker[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const w of workers) w.input.end();
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("worker 遥测装配（telemetryKit 写 <agentDir>/telemetry.db）", () => {
  test("script worker 跑一回合：session/turn/step/llm.chat span 落库 + usage 四字段 + log 流", async () => {
    const w = await spawnScriptWorker({ script: [{ reply: "measured" }] });
    workers.push(w);
    w.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(w.captured.lines, "thread/start", "s1");
    if (!started.success) throw new Error(String(started.error));
    const threadId = (started.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "hello" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "sp1");

    const dbPath = telemetryDbPathOf(w.agentDir);
    const reopen = new Database(dbPath, { readonly: true });
    const sessions = reopen.query("SELECT session_id FROM otel_sessions").all() as { session_id: string }[];
    expect(sessions.map((row) => row.session_id)).toEqual([threadId]);
    const query = createQueryService(createBunSqliteExecutor(reopen));
    const names = query.spansOf(threadId).map((row) => row.name);
    expect(names[0]).toBe("session");
    expect(names).toContain("turn");
    expect(names).toContain("step");
    expect(names).toContain("llm.chat");
    expect(query.usageOf(threadId)).toEqual({ inputTokens: 64, outputTokens: 16 + "measured".length, cacheRead: 0, cacheWrite: 0 });
    expect(query.logsOf(threadId).length).toBeGreaterThan(3);
    reopen.close();
  }, 20_000);

  test("resume 续链：同 sessionId 重开复用 trace，无重复 session 行", async () => {
    const w = await spawnScriptWorker({ script: [{ reply: "one" }, { reply: "two" }] });
    workers.push(w);
    w.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(w.captured.lines, "thread/start", "s1");
    if (!started.success) throw new Error(String(started.error));
    const threadId = (started.data as { threadId: string }).threadId;
    w.send({ type: "prompt", id: "p1", threadId, message: "first" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p1");
    w.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "sp1");

    const sessionPath = join(w.sessionsRoot, threadId, "events.jsonl");
    w.send({ type: "thread/resume", id: "r1", sessionPath });
    const resumed = await waitResponse(w.captured.lines, "thread/resume", "r1");
    expect(resumed.success).toBe(true);
    w.send({ type: "prompt", id: "p2", threadId, message: "second" });
    await waitEvent(w.captured.lines, "settled", (p) => (p as { sendId?: string }).sendId === "p2");
    w.send({ type: "thread/stop", id: "sp2", threadId });
    await waitResponse(w.captured.lines, "thread/stop", "sp2");

    const reopen = new Database(telemetryDbPathOf(w.agentDir));
    const sessions = reopen.query("SELECT session_id, trace_id FROM otel_sessions").all() as { session_id: string; trace_id: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session_id).toBe(threadId);
    const turns = (reopen.query("SELECT COUNT(*) AS n FROM otel_spans WHERE session_id = ? AND name = 'turn'").get(threadId) as { n: number }).n;
    expect(turns).toBe(2);
    reopen.close();
  }, 20_000);
});

describe("telemetry purge（thread/delete 配套清理）", () => {
  test("purge 级联清三表；重复 purge 复用同连接；close 后可再开", async () => {
    const root = await tempDir("hub-tel-purge-");
    const dbPath = join(root, "telemetry.db");
    const seed = new Database(dbPath);
    const exec = createBunSqliteExecutor(seed);
    ensureSchema(exec);
    exec.run("INSERT INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES ('gone', 'tr-gone', 1, '{}')", []);
    exec.run("INSERT INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES ('kept', 'tr-kept', 2, '{}')", []);
    exec.run("INSERT INTO otel_spans (trace_id, span_id, parent_span_id, session_id, name, kind, start_ms, end_ms, status_code, status_message, attributes) VALUES ('tr-gone', 'sp1', NULL, 'gone', 'session', 'INTERNAL', 1, NULL, 'UNSET', NULL, '{}')", []);
    exec.run("INSERT INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES ('gone', 0, 1, 'tr-gone', NULL, 'INFO', 'turn/start', NULL)", []);
    seed.close();

    const purge = createTelemetryPurge({ dbPath, onWarn: () => {} });
    purge.purge(["gone"]);
    purge.purge(["kept"]);
    purge.close();

    const reopen = new Database(dbPath, { readonly: true });
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_sessions").get() as { n: number }).n).toBe(0);
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_spans").get() as { n: number }).n).toBe(0);
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_logs").get() as { n: number }).n).toBe(0);
    reopen.close();
  });

  test("库文件缺席/目录不可写（CANTOPEN）静默不建库；库无 schema（no such table）静默", async () => {
    const root = await tempDir("hub-tel-purge-missing-");
    const warnings: string[] = [];
    const missing = createTelemetryPurge({ dbPath: join(root, "no-such-dir", "telemetry.db"), onWarn: (message) => warnings.push(message) });
    missing.purge(["gone"]);
    expect(warnings).toEqual([]);
    expect(existsSync(join(root, "no-such-dir"))).toBe(false);

    const unschema = createTelemetryPurge({ dbPath: join(root, "empty.db"), onWarn: (message) => warnings.push(message) });
    unschema.purge(["gone"]);
    expect(warnings).toEqual([]);
    unschema.close();
    const check = new Database(join(root, "empty.db"), { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n).toBe(0);
    check.close();
  });

  test("BUSY 写锁竞争静默（等满 busy_timeout 后重置，解锁后可再 purge）", { timeout: 20_000 }, async () => {
    const root = await tempDir("hub-tel-purge-busy-");
    const dbPath = join(root, "telemetry.db");
    const seed = new Database(dbPath);
    const exec = createBunSqliteExecutor(seed);
    ensureSchema(exec);
    exec.run("INSERT INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES ('busy1', 'tr-busy', 1, '{}')", []);
    seed.close();

    const blocker = new Database(dbPath);
    blocker.exec("BEGIN EXCLUSIVE");
    const warnings: string[] = [];
    const purge = createTelemetryPurge({ dbPath, onWarn: (message) => warnings.push(message) });
    purge.purge(["busy1"]);
    expect(warnings).toEqual([]);
    blocker.exec("COMMIT");
    blocker.close();
    purge.purge(["busy1"]);
    purge.close();
    const reopen = new Database(dbPath, { readonly: true });
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_sessions").get() as { n: number }).n).toBe(0);
    reopen.close();
  });

  test("删除流程接线：deleteSession 携 purge 后三表行随档案消失（含级联子会话）", async () => {
    const root = await tempDir("hub-tel-delete-");
    const sessionsRoot = join(root, "sessions");
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    const dbPath = telemetryDbPathOf(agentDir);
    const seed = new Database(dbPath);
    const exec = createBunSqliteExecutor(seed);
    ensureSchema(exec);
    for (const id of ["p", "c1"]) {
      exec.run("INSERT INTO otel_sessions (session_id, trace_id, created_ms, header) VALUES (?, ?, 1, '{}')", [id, `tr-${id}`]);
      exec.run("INSERT INTO otel_logs (session_id, seq, ts_ms, trace_id, span_id, severity, event_type, body) VALUES (?, 0, 1, ?, NULL, 'INFO', 'turn/start', NULL)", [id, `tr-${id}`]);
    }
    seed.close();
    for (const id of ["p", "c1"]) {
      await mkdir(join(sessionsRoot, id), { recursive: true });
      await writeFile(join(sessionsRoot, id, "events.jsonl"), "", "utf8");
    }
    await writeFile(join(sessionsRoot, "c1", "header.json"), JSON.stringify({ id: "c1", createdAt: 1, cwd: "/w", agentId: "agent-1", parentSession: "p" }), "utf8");
    await writeFile(join(sessionsRoot, "p", "header.json"), JSON.stringify({ id: "p", createdAt: 1, cwd: "/w" }), "utf8");

    const { deleteSession } = await import("../host/session-delete.ts");
    const { createThreadTable } = await import("../host/thread-table.ts");
    const result = await deleteSession(
      { table: createThreadTable(), sessionsRoot, taskLogsRoot: join(root, "task-logs"), agentDir, telemetry: createTelemetryPurge({ dbPath, onWarn: () => {} }) },
      join(sessionsRoot, "p", "events.jsonl"),
    );
    expect(result).toEqual({ ok: true, removed: ["p", "c1"] });

    const reopen = new Database(dbPath, { readonly: true });
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_sessions").get() as { n: number }).n).toBe(0);
    expect((reopen.query("SELECT COUNT(*) AS n FROM otel_logs").get() as { n: number }).n).toBe(0);
    reopen.close();
  });
});
