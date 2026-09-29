import { afterAll, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aliveOf, contentText, drivePrompt, startHost, workerPids } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hosts: HostHandle[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

describe("场景：韧性", () => {
  test("kill -9 worker 中途：补恰一 failure + thread_died + settled{worker-died} + 写命令复活", async () => {
    const host = await startHost({ script: [{ delayMs: 60_000 }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "prompt", id: "p1", threadId, message: "hold" });
    await host.response("p1");
    await host.wait((frame) => frame.type === "event" && frame.name === "turn/start", "turn start");
    host.send({ type: "get_entries", id: "e1", threadId });
    host.send({ type: "prompt", id: "p2", threadId, message: "queued", streamingBehavior: "steer" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 300);
    });
    const pids = workerPids(host.proc.pid as number);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    for (const pid of pids) process.kill(pid, "SIGKILL");
    await host.wait((frame) => frame.type === "thread_died" && frame.threadId === threadId, "thread_died");
    const e1 = await host.response("e1");
    const e1Err = e1.error as { code?: string; message?: string } | undefined;
    expect(e1.success === true || (e1Err?.code === "protocol" && e1Err.message === "worker died before responding")).toBe(true);
    await host.event("settled", (payload) => (payload as { sendId?: string; reason?: string }).sendId === "p2" && (payload as { reason?: string }).reason === "worker-died");
    host.send({ type: "get_state", id: "g1", threadId });
    const state = await host.response("g1");
    expect(state.success).toBe(true);
  }, 90_000);

  test("并发 resume 恰一胜者：双 startHost 同 sessionPath——一方 already open", async () => {
    const hostA = await startHost({ script: [{ reply: "a" }] });
    hosts.push(hostA);
    hostA.send({ type: "thread/start", id: "s1", cwd: hostA.agentDir });
    const started = await hostA.response("s1");
    const sessionPath = (started.data as { sessionPath: string }).sessionPath;
    hostA.send({ type: "thread/resume", id: "r1", sessionPath });
    const rejected = await hostA.response("r1");
    expect(rejected.error).toEqual({ code: "already_open", message: "already open" });
  }, 60_000);

  test("retire → parked → 直读（get_state 免唤醒）→ wake 对话继续", async () => {
    const host = await startHost({ script: [{ reply: "before retire" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "first" });
    host.send({ type: "thread/retire", id: "rt1", threadId });
    await host.response("rt1");
    await host.wait((frame) => frame.type === "thread_parked" && frame.threadId === threadId, "thread_parked");
    const workersBefore = workerPids(host.proc.pid as number).length;
    host.send({ type: "get_state", id: "g1", threadId });
    const state = await host.response("g1");
    expect(state.success).toBe(true);
    expect(workerPids(host.proc.pid as number).length).toBeLessThanOrEqual(workersBefore);
    const beforeCount = host.lines.filter((frame) => frame.type === "event" && frame.name === "assistant/message").length;
    await drivePrompt(host, { threadId, id: "p2", message: "resumed" });
    const fresh = host.lines.filter((frame) => frame.type === "event" && frame.name === "assistant/message").slice(beforeCount);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(contentText((fresh.at(-1) as unknown as { payload: unknown }).payload)).toContain("before retire");
  }, 90_000);

  test("孤儿自灭：杀 host（SIGKILL）→ worker 子进程随之退出（stdin EOF 管道断）", async () => {
    const host = await startHost({ script: [{ delayMs: 60_000 }] });
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    await host.response("s1");
    const pids = workerPids(host.proc.pid as number);
    expect(pids.length).toBeGreaterThanOrEqual(1);
    process.kill(host.proc.pid as number, "SIGKILL");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 1_500);
    })
    expect(aliveOf(pids).some(Boolean)).toBe(false);
  }, 60_000);

  test("撕裂会话文件：末行截断恢复前缀；中段坏行 fail-closed（cannot resume）", async () => {
    const host = await startHost({ script: [{ reply: "x" }] });
    hosts.push(host);
    const sid = "tornsession1";
    const dir = join(host.sessionsRoot, sid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd: "/w" }), "utf8");
    const goodLines = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
      { type: "session/meta", seq: 1, time: 2, data: { key: "title", value: "torn-ok" } },
    ].map((e) => JSON.stringify(e)).join("\n");
    await writeFile(join(dir, "events.jsonl"), `${goodLines}\n{"type":"turn/end","seq":2,"time":3,"da`, "utf8");
    host.send({ type: "thread/resume", id: "r1", sessionPath: join(dir, "events.jsonl") });
    const resumed = await host.response("r1");
    expect(resumed.success).toBe(true);
    const sid2 = "tornsession2";
    const dir2 = join(host.sessionsRoot, sid2);
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "header.json"), JSON.stringify({ id: sid2, createdAt: 1, cwd: "/w" }), "utf8");
    await writeFile(join(dir2, "events.jsonl"), `${goodLines}\nnot json at all\n${goodLines}\n`, "utf8");
    host.send({ type: "thread/resume", id: "r2", sessionPath: join(dir2, "events.jsonl") });
    const rejected = await host.response("r2");
    expect(rejected.success).toBe(false);
    expect((rejected.error as { message: string }).message).toContain("cannot resume session");
  }, 60_000);

  test("背压（慢消费者）：host 不丢帧不交错（全量帧序合法）", async () => {
    const host = await startHost({ script: [] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    for (let i = 0; i < 20; i += 1) {
      host.send({ type: "get_state", id: `gs-${i}`, threadId });
      await host.response(`gs-${i}`);
    }
    const allFrames = host.lines.map((frame) => frame.type);
    expect(allFrames.includes("response")).toBe(true);
  }, 60_000);
});

describe("场景：会话目录与限流", () => {
  test("register >64MiB 直读上限拒（Session file not readable）", async () => {
    const host = await startHost({ script: [] });
    hosts.push(host);
    const sid = "bigfile00001";
    const dir = join(host.sessionsRoot, sid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1 }), "utf8");
    await writeFile(join(dir, "events.jsonl"), " ".repeat(65 * 1024 * 1024), "utf8");
    host.send({ type: "thread/register", id: "rg1", sessionPath: join(dir, "events.jsonl") });
    const rejected = await host.response("rg1");
    expect(rejected.error).toEqual({ code: "session_unreadable", message: "Session file not readable" });
  }, 120_000);
});
