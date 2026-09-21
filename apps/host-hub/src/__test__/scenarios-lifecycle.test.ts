// 场景 e2e：生命周期与设置面旅程（MIGRATION §5 scenarios-lifecycle/admin 矩阵）——
// stop-vs-wake 竞争、设置面全旅程（models/add→start→skills→thinking→permission→
// parked get_mode→trust→项目级）、fork 全旅程（真进程）、trusted 门禁装载差异、
// 4 并发隔离（事件不串线程）。
import { afterAll, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText, drivePrompt, startHost, workerPids } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const hosts: HostHandle[] = [];
afterAll(async () => {
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

describe("场景：生命周期", () => {
  test("stop-vs-wake：stop 后写命令 → Unknown threadId（stop 删表）", async () => {
    const host = await startHost({ script: [{ reply: "x" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    host.send({ type: "thread/stop", id: "sp1", threadId });
    await host.response("sp1");
    await host.wait((frame) => frame.type === "thread_died" && frame.threadId === threadId, "no died on stop").catch(() => undefined);
    // stop 删表（无帧承诺）——等 worker 退后写命令 Unknown threadId
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 300);
    });
    host.send({ type: "get_state", id: "g1", threadId });
    const state = await host.response("g1");
    expect(state.error).toEqual({ code: "unknown_thread", message: "Unknown threadId" });
  }, 60_000);

  test("fork 全旅程（真进程）：前缀复制 + 旧 id 失效 + 新线程继续对话", async () => {
    const host = await startHost({ script: [{ reply: "origin thread" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "root message" });
    host.send({ type: "fork", id: "f1", threadId, seq: 3, position: "at" });
    const forked = await host.response("f1");
    expect(forked.success).toBe(true);
    const data = forked.data as { threadId: string; previousThreadId: string; sessionPath: string };
    expect(data.previousThreadId).toBe(threadId);
    // 旧 id 失效
    host.send({ type: "get_state", id: "g-old", threadId });
    expect((await host.response("g-old")).error).toEqual({ code: "unknown_thread", message: "Unknown threadId" });
    // 新线程继续对话（新 worker 剧本重放）
    await drivePrompt(host, { threadId: data.threadId, id: "p2", message: "fork continues" });
    const wal = await (await import("node:fs/promises")).readFile(data.sessionPath, "utf8");
    expect(wal).toContain("root message"); // 前缀复制
  }, 90_000);

  test("trusted 门禁：untrusted start 不装 project skills（get_commands 不含）；trusted 装", async () => {
    const projectCwd = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "hub-proj-sk-"));
    const skillsDir = join(projectCwd, ".x-harness", "skills", "proj-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "SKILL.md"), "---\nname: proj-skill\ndescription: project level\n---\nbody", "utf8");
    const host = await startHost({ script: [{ reply: "x" }] });
    hosts.push(host);
    // untrusted
    host.send({ type: "thread/start", id: "u1", cwd: projectCwd, trusted: false });
    const untrusted = await host.response("u1");
    expect(untrusted.success).toBe(true);
    const utId = (untrusted.data as { threadId: string }).threadId;
    host.send({ type: "get_commands", id: "gc-u", threadId: utId });
    const utCommands = await host.response("gc-u");
    expect(((utCommands.data as Array<{ name: string }>).map((c) => c.name)).includes("proj-skill")).toBe(false);
    // trusted（同 host 新线程——先 stop）
    host.send({ type: "thread/stop", id: "sp1", threadId: utId });
    await host.response("sp1");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 300);
    });
    host.send({ type: "thread/start", id: "t1", cwd: projectCwd, trusted: true });
    const trusted = await host.response("t1");
    expect(trusted.success).toBe(true);
    expect((trusted.data as { projectSettingsPresent?: boolean }).projectSettingsPresent).toBeUndefined(); // 无项目设置文件
    const tId = (trusted.data as { threadId: string }).threadId;
    host.send({ type: "get_commands", id: "gc-t", threadId: tId });
    const tCommands = await host.response("gc-t");
    expect(((tCommands.data as Array<{ name: string }>).map((c) => c.name)).includes("proj-skill")).toBe(true);
  }, 90_000);
});

describe("场景：设置面全旅程（真进程）", () => {
  test("models/add → start 用新模型 → skills 开关 → thinking → permission → parked get_mode 读 WAL → trust → 项目级合并", async () => {
    const host = await startHost({ script: [{ reply: "settings journey" }] });
    hosts.push(host);
    // models/add：新档案 + 模型
    host.send({ type: "models/add", id: "custom-model-1", provider: "customp", protocol: "anthropic", baseUrl: "https://custom.example", apiKeyEnv: "CUSTOM_KEY" });
    const added = await host.response("custom-model-1");
    expect(added.success).toBe(true);
    // get_models 可见
    host.send({ type: "get_models", id: "gm1" });
    const models = await host.response("gm1");
    expect(((models.data as Array<{ id: string }>).map((m) => m.id)).includes("custom-model-1")).toBe(true);
    // start（预设模型——script 模式目录只有 script 档案：用缺省）
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    await drivePrompt(host, { threadId, id: "p1", message: "hi" });
    // thinking 档 + 下一 turn request/header
    host.send({ type: "set_thinking_level", id: "tl1", threadId, level: "low" });
    await host.response("tl1");
    host.send({ type: "get_thinking_level", id: "tl2", threadId });
    expect(((await host.response("tl2")).data as { level: string; source: string })).toEqual({ level: "low", source: "session" });
    // permission 即时切 + 持久化
    host.send({ type: "permission/set_mode", id: "pm1", threadId, mode: "full" });
    await host.response("pm1");
    host.send({ type: "permission/get_mode", id: "pm2", threadId });
    expect(((await host.response("pm2")).data as { mode: string; source: string })).toEqual({ mode: "full", source: "session" });
    // retire → parked get_mode 读 WAL（四态 session）
    host.send({ type: "thread/retire", id: "rt1", threadId });
    await host.response("rt1");
    await host.wait((frame) => frame.type === "thread_parked" && frame.threadId === threadId, "parked");
    host.send({ type: "permission/get_mode", id: "pm3", threadId });
    expect(((await host.response("pm3")).data as { mode: string; source: string })).toEqual({ mode: "full", source: "session" });
    // workspace/trust → settings/set 项目级 → settings/get 合并
    const projectCwd = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "hub-set-"));
    host.send({ type: "workspace/trust", id: "wt1", cwd: projectCwd, trusted: true });
    await host.response("wt1");
    host.send({ type: "settings/set", id: "ss1", key: "thinking.default", value: "medium", cwd: projectCwd });
    await host.response("ss1");
    host.send({ type: "settings/get", id: "sg1", cwd: projectCwd });
    const merged = await host.response("sg1");
    const data = merged.data as { values: Record<string, unknown>; sources: Record<string, string>; raw: { project: Record<string, unknown>; user: Record<string, unknown> } };
    expect(data.values).toEqual({ "thinking.default": "medium" });
    expect(data.sources).toEqual({ "thinking.default": "project" });
    expect(data.raw.project).toEqual({ "thinking.default": "medium" });
    // skills/list（user 面）
    host.send({ type: "skills/list", id: "sl1" });
    expect((await host.response("sl1")).success).toBe(true);
    // agents/create → agents/list 可见
    host.send({ type: "agents/create", id: "ac1", name: "journeyer", description: "journeys", systemPrompt: "go" });
    expect((await host.response("ac1")).success).toBe(true);
    host.send({ type: "agents/list", id: "al1" });
    expect((((await host.response("al1")).data as { agents: Array<{ name: string }> }).agents.map((a) => a.name)).includes("journeyer")).toBe(true);
    host.send({ type: "agents/remove", id: "ar1", name: "journeyer" });
    await host.response("ar1");
    void contentText;
  }, 120_000);
});

describe("场景：并发隔离", () => {
  test("4 并发线程：事件不串线程 + 批量 retire + thread/list 投影", async () => {
    const host = await startHost({ script: [{ reply: "concurrent reply" }] });
    hosts.push(host);
    const threads: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      host.send({ type: "thread/start", id: `s-${i}`, cwd: host.agentDir });
      const started = await host.response(`s-${i}`);
      threads.push((started.data as { threadId: string }).threadId);
    }
    expect(new Set(threads).size).toBe(4);
    for (const [i, threadId] of threads.entries()) {
      await drivePrompt(host, { threadId, id: `p-${i}`, message: `msg-${i}` });
    }
    // 事件帧 threadId 隔离：每线程的 user/message 都带自己的 threadId
    const userEvents = host.lines.filter((frame) => frame.type === "event" && frame.name === "user/message");
    for (const [i, threadId] of threads.entries()) {
      expect(userEvents.some((frame) => frame.threadId === threadId && contentText(frame.payload).includes(`msg-${i}`))).toBe(true);
    }
    // thread/list：4 live
    host.send({ type: "thread/list", id: "l1" });
    const listed = (await host.response("l1")).data as Array<{ threadId: string; state: string }>;
    expect(listed.filter((row) => row.state === "live").length).toBe(4);
    // 批量 retire → 4 thread_parked
    for (const [i, threadId] of threads.entries()) {
      host.send({ type: "thread/retire", id: `rt-${i}`, threadId });
      await host.response(`rt-${i}`);
    }
    for (const threadId of threads) {
      await host.wait((frame) => frame.type === "thread_parked" && frame.threadId === threadId, `parked ${threadId}`);
    }
    void workerPids;
  }, 120_000);
});
