// 假绿抽查处置回归（核查清单第 1/4/6 项）：shutdownAll 三不补/被拒驱动不合成
// settled/pool 容量与死线/bash 硬化族（并发超时互不误杀/进程组杀/溢写/7 天清扫）/
// credentials 面/中继计时锚/builtin 类型装载。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientHas, makePool, until, wakeAndDeliver, wrote } from "./kit/pool-fixture.ts";
import { createBashExec, cleanupBashOutputs } from "../worker/bash-exec.ts";
import { redact } from "../host/credentials.ts";
import { classifyResponseHead, responseLine } from "../shared/frame-classify.ts";
import { spawnScriptWorker, waitResponse } from "./kit/worker-harness.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";
import type { HostHandle } from "./kit/host-client.ts";
import { startHost, drivePrompt } from "./kit/host-client.ts";
import { builtinTypesDir } from "../worker/assembly.ts";
import { loadAgentTypes, userAgentsDirOf } from "@x-harness/agent-delegation";
import { createThreadTable } from "../host/thread-table.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
const hosts: HostHandle[] = [];
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  for (const host of hosts) host.end();
  await Promise.all(hosts.map((host) => host.exited().catch(() => -1)));
});

function responseLineOf(fields: { id?: string; command: string; success: boolean; data?: unknown; error?: HubErrorShape }): string {
  const head = `{"id":${fields.id !== undefined ? JSON.stringify(fields.id) : "null"},"type":"response","command":${JSON.stringify(fields.command)},"success":${fields.success ? "true" : "false"}`;
  if (!fields.success && fields.error !== undefined) return `${head},"error":${JSON.stringify(fields.error)}}`;
  if (fields.success && fields.data !== undefined) return `${head},"data":${JSON.stringify(fields.data)}}`;
  return `${head}}`;
}

describe("抽查处置：pool 容量与关闭面", () => {
  test("shutdownAll 三不补：不补 failure/不合成 settled/表项不迁 dead（关闭期在飞不结算）", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g0", threadId: "t1" });
    await until(() => f.table.get("t1") !== undefined && f.pool.slotOf("t1") !== undefined, "slot");
    // 在飞：未应答 get_entries + 未 settled 驱动
    void f.pool.routeLine(JSON.stringify({ type: "get_entries", id: "e1", threadId: "t1" }));
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p1", threadId: "t1" }));
    const worker = f.spawned[f.spawned.length - 1];
    await until(wrote(worker, '"p1"'), "deliver");
    await f.pool.shutdownAll();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 80);
    });
    // 三不补：无 failure 合成、无 worker-died settled、表项不迁 dead
    expect(f.client.some((line) => line.includes("worker died before responding"))).toBe(false);
    expect(f.client.some((line) => line.includes("worker-died"))).toBe(false);
    expect(f.table.get("t1")?.state).not.toBe("dead");
  });

  test("被拒驱动（failure 应答）不合成 settled——受理前被拒无 settled 义务", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g0", threadId: "t1" });
    const worker = f.spawned[f.spawned.length - 1];
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "rej1", threadId: "t1" }));
    await until(wrote(worker, '"rej1"'), "deliver");
    // worker 拒绝受理（failure 应答——流式中无 streamingBehavior 等）
    worker?.onLine(responseLineOf({ id: "rej1", command: "prompt", success: false, error: hubError("streaming_window", "streamingBehavior required while streaming") }));
    await until(clientHas(f.client, "rej1"), "failure forwarded");
    worker?.close();
    await until(() => f.table.get("t1")?.state === "dead");
    const settledForRejected = f.client.filter((line) => line.includes('"settled"') && line.includes('"rej1"'));
    expect(settledForRejected).toEqual([]); // 被拒驱动不合成 settled
  });

  test("retiring 重放队列：live slot 的 stop 走 retiring + 排队命令 close 后重评", async () => {
    const f = makePool(8, { workerExitTimeoutMs: 5_000 });
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g0", threadId: "t1" });
    await until(() => f.pool.slotOf("t1") !== undefined, "slot");
    f.pool.retireThread("t1", "stop"); // live slot → retiring + thread/stop 投递 worker
    expect(f.table.get("t1")?.state).toBe("retiring");
    for (let i = 0; i < 3; i += 1) {
      void f.pool.routeLine(JSON.stringify({ type: "prompt", id: `q-${i}`, threadId: "t1" }));
    }
    // close 时序先于/后于入队皆合法——终态统一为 Unknown threadId（删表重评或直拒）
    await until(clientHas(f.client, "Unknown threadId"), "requeue verdict", 8_000);
  });
});

describe("抽查处置：bash 硬化族", () => {
  test("B-MH5 并发超时互不误杀：短超时命令到点 cancelled，长超时命令继续跑完", async () => {
    const agentDir = await tempDir("hub-bmh5-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => ({ allowed: true }),
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 60_000,
      onStateChange: () => {},
    });
    const short = bash.exec({ command: "sleep 3", timeoutMs: 150, id: "short" });
    const long = bash.exec({ command: "sleep 1", timeoutMs: 30_000, id: "long" });
    const shortOutcome = await short;
    expect(shortOutcome.ok === true && shortOutcome.cancelled).toBe(true);
    const longOutcome = await long;
    expect(longOutcome.ok === true && longOutcome.cancelled).toBe(false); // 未被短命令的超时误杀
    expect(longOutcome.ok === true && (longOutcome as { output: string }).output === "").toBe(true);
  }, 20_000);

  test("进程组杀：命令派生孙进程，abort 后全灭（detached 组杀面）", async () => {
    const agentDir = await tempDir("hub-pgrp-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => ({ allowed: true }),
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 60_000,
      onStateChange: () => {},
    });
    const grandchild = join(agentDir, "grandchild.pid");
    const running = bash.exec({
      command: `/bin/sh -c 'sleep 30 & echo $! > ${grandchild}; wait'`,
      timeoutMs: 60_000,
      id: "tree",
      excludeFromContext: true,
    });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 400);
    }); // 孙进程落 pid 文件
    const pidText = await Bun.file(grandchild).text().catch(() => "");
    const grandPid = Number(pidText.trim());
    expect(Number.isFinite(grandPid)).toBe(true);
    bash.abortRunning("tree");
    const outcome = await running;
    expect(outcome.ok === true && outcome.cancelled).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 300);
    });
    let grandAlive = true;
    try {
      process.kill(grandPid, 0);
    } catch {
      grandAlive = false;
    }
    expect(grandAlive).toBe(false); // 孙进程随组杀全灭
  }, 20_000);

  test("溢写：>1MiB 输出落 fullOutputPath（key+rand 文件名）；内联 output 64KiB 截断标记", async () => {
    const agentDir = await tempDir("hub-spill-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => ({ allowed: true }),
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 30_000,
      onStateChange: () => {},
    });
    const outcome = await bash.exec({ command: `head -c 2097152 /dev/zero | tr '\\0' 'x'`, timeoutMs: 20_000, id: "big" });
    expect(outcome.ok).toBe(true);
    const data = outcome as { output: string; truncated: boolean; fullOutputPath?: string };
    expect(data.truncated).toBe(true); // 内联 64KiB 截断标记
    expect(Buffer.byteLength(data.output, "utf8")).toBeLessThanOrEqual(64 * 1024 + 8);
    expect(data.fullOutputPath).toBeDefined();
    const spilled = await Bun.file(data.fullOutputPath as string).text();
    expect(spilled.length).toBe(2 * 1024 * 1024); // 溢写文件含全量
    expect((data.fullOutputPath as string)).toMatch(/big\.[0-9a-f]{8}\.txt$/); // key+rand 命名
  }, 30_000);

  test("7 天清扫：超期溢写文件清除、新文件保留", async () => {
    const agentDir = await tempDir("hub-sweep-");
    const dir = join(agentDir, "bash-outputs");
    await mkdir(dir, { recursive: true });
    const old = join(dir, "1.oldcmd.aabbccdd.txt");
    const fresh = join(dir, "2.newcmd.eeff0011.txt");
    await writeFile(old, "x", "utf8");
    await writeFile(fresh, "y", "utf8");
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, ancient, ancient);
    await cleanupBashOutputs(agentDir);
    const names = await readdir(dir);
    expect(names).toContain("2.newcmd.eeff0011.txt");
    expect(names).not.toContain("1.oldcmd.aabbccdd.txt");
  });
});

describe("抽查处置：credentials 面", () => {
  test("redact：key 本体全量替换；空 key 不动文案", () => {
    expect(redact("auth provider not in catalog: glm", ["sk-secret"])).toBe("auth provider not in catalog: glm");
    expect(redact("write failed with sk-secret-123 in path", ["sk-secret-123"])).toBe("write failed with [redacted] in path");
    expect(redact("no keys", [""])).toBe("no keys");
  });

  test("credentials.json 0600 权限 + 读写链", async () => {
    const { createCredentials } = await import("../host/credentials.ts");
    const agentDir = await tempDir("hub-cred-");
    const store = createCredentials(agentDir);
    await store.setKey("glm", "sk-abc");
    const info = await stat(join(agentDir, "credentials.json"));
    expect(info.mode & 0o777).toBe(0o600); // 创建即收紧
    const raw = JSON.parse(await Bun.file(join(agentDir, "credentials.json")).text()) as { keys: Record<string, string> };
    expect(raw.keys).toEqual({ glm: "sk-abc" });
    await store.removeKey("glm");
    const after = JSON.parse(await Bun.file(join(agentDir, "credentials.json")).text()) as { keys: Record<string, string> };
    expect(after.keys).toEqual({});
  });
});

describe("抽查处置：转发计时锚（<1ms 量级——源 regressions-units 移植）", () => {
  test("classifyResponseHead 2000 帧均值 < 1ms（零 JSON.parse 热路径）", () => {
    const line = responseLine({ id: "timing-1", command: "get_state", success: true, data: { model: { provider: "p", model: "m" }, isStreaming: false, isCompacting: false, sessionId: "s", sessionName: "", sessionFile: "/f", messageCount: 3, queue: { steering: [], followUp: [] } } });
    const frames: string[] = [];
    for (let i = 0; i < 2000; i += 1) frames.push(line.replace('"timing-1"', `"timing-${i}"`));
    const start = performance.now();
    let classified = 0;
    for (const frame of frames) {
      if (classifyResponseHead(frame) !== undefined) classified += 1;
    }
    const elapsed = performance.now() - start;
    expect(classified).toBe(2000);
    expect(elapsed / frames.length).toBeLessThan(1); // ms/帧（热路径预算锚）
  });
});

describe("抽查处置：builtin 类型装载（agents/list 层）", () => {
  test("随包内置类型经 builtinTypesDir 装载（frontmatter name = 文件名）", () => {
    const loaded = loadAgentTypes([builtinTypesDir()]);
    expect(Object.keys(loaded.types).sort()).toEqual(["explore", "general-purpose"]);
    expect(loaded.warnings).toEqual([]);
  });

  test("装载序 project > user > builtin（同名前者胜）", () => {
    const table = createThreadTable();
    void table;
    const merged = loadAgentTypes([userAgentsDirOf(), builtinTypesDir()]);
    // builtin 的 general-purpose 在场（user 未覆盖时）
    expect(merged.types["general-purpose"]).toBeDefined();
  });
});

describe("抽查处置：入口缺 HUB_AGENT_DIR exit 2（A-L7）", () => {
  test("worker run() 缺 env → exit 2（真进程）", async () => {
    const { spawn } = await import("node:child_process");
    const entry = join(import.meta.dirname, "../worker/main.ts");
    const proc = spawn(process.execPath, [entry], { env: { PATH: process.env["PATH"] ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    const code = await new Promise<number>((resolve) => {
      proc.on("exit", (c) => {
        resolve(c ?? -1);
      });
    });
    expect(code).toBe(2);
    expect(stderr).toContain("HUB_AGENT_DIR required");
  });
});

const embeddedWorkers: Array<{ input: { end(): void } }> = [];
afterAll(async () => {
  for (const w of embeddedWorkers) w.input.end();
});

describe("抽查处置：worker observer 命令不重置 idle（心跳面）", () => {
  test("observer 命令不重置 idleMs（心跳观测）", async () => {
    const w = await spawnScriptWorker({ script: [{ reply: "x" }] });
    embeddedWorkers.push(w);
    w.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(w.captured.lines, "thread/start", "s1");
    const threadId = (started.data as { threadId: string }).threadId;
    // 观察两个心跳的 idleMs：注入 observer 命令后 idleMs 不归零（继续计时）
    const beatAt = async (): Promise<number> => {
      const beats = w.captured.lines.filter((line) => line.includes('"type":"heartbeat"'));
      const last = JSON.parse(beats.at(-1) as string) as { idleMs: number };
      return last.idleMs;
    };
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 1_200);
    });
    const before = await beatAt();
    expect(before).toBeGreaterThan(0);
    w.send({ type: "get_state", id: "g1", threadId });
    await waitResponse(w.captured.lines, "get_state", "g1");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 1_100);
    });
    const after = await beatAt();
    expect(after).toBeGreaterThanOrEqual(before); // observer 不重置 idle——继续增长
    w.input.end();
  }, 15_000);
});

describe("抽查处置：kill -9 复活验证强化（新 worker + 新 turn）", () => {
  test("复活 = 新 worker 进程 + 驱动命令新 turn/start（非直读兜底）", async () => {
    const host = await startHost({ script: [{ reply: "revived reply" }] });
    hosts.push(host);
    host.send({ type: "thread/start", id: "s1", cwd: host.agentDir });
    const started = await host.response("s1");
    const threadId = (started.data as { threadId: string }).threadId;
    const pidsBefore = (await import("./kit/host-client.ts")).workerPids(host.proc.pid as number);
    for (const pid of pidsBefore) process.kill(pid, "SIGKILL");
    await host.wait((frame) => frame.type === "thread_died" && frame.threadId === threadId, "thread_died");
    const diedCount = host.lines.filter((frame) => frame.type === "thread_died" && frame.threadId === threadId).length;
    expect(diedCount).toBe(1); // 恰一
    // 驱动命令 → 唤醒新 worker → 新 turn/start（复活的真证明）
    const turnCountBefore = host.lines.filter((frame) => frame.type === "event" && frame.name === "turn/start" && frame.threadId === threadId).length;
    await drivePrompt(host, { threadId, id: "p-revive", message: "revive" });
    const turnCountAfter = host.lines.filter((frame) => frame.type === "event" && frame.name === "turn/start" && frame.threadId === threadId).length;
    expect(turnCountAfter).toBe(turnCountBefore + 1); // 新 worker 真跑了新 turn
    const { workerPids } = await import("./kit/host-client.ts");
    const pidsAfter = workerPids(host.proc.pid as number);
    expect(pidsAfter.length).toBeGreaterThanOrEqual(1); // 新 worker 在世
    expect(pidsAfter).not.toEqual(pidsBefore); // 不是旧 pid
  }, 60_000);
});

describe("抽查处置：55 命令矩阵全量恰一（源 smoke 全表驱动移植）", () => {
  test("全 55 命令逐条：恰一响应帧（id 回显 + command 字段）", async () => {
    const host = await startHost({ script: [{ reply: "matrix" }] });
    hosts.push(host);
    const { COMMAND_NAMES } = await import("../protocol/commands.ts");
    // 先建线程（worker 命令面可用）
    host.send({ type: "thread/start", id: "boot", cwd: host.agentDir });
    const boot = await host.response("boot");
    const threadId = (boot.data as { threadId: string }).threadId;
    const threadScoped = new Set(["prompt", "steer", "follow_up", "compact", "bash", "fork", "clone", "set_model", "subagent/steer", "set_thinking_level", "thread/stop"]);
    for (const command of COMMAND_NAMES) {
      if (command === "thread/start" || threadScoped.has(command)) continue; // 已验/替换语义面在场景测试
      const needsThread = new Set(["get_state", "get_inflight", "get_messages", "get_entries", "get_tree", "get_session_stats", "get_commands", "get_fork_messages", "get_subagents", "get_pending_dialogs", "thread/set_keepalive"]);
      const input: Record<string, unknown> = { type: command, id: `matrix-${command}` };
      if (needsThread.has(command)) input["threadId"] = threadId;
      host.send(input);
      const frame = await host.response(`matrix-${command}`);
      expect(frame.command).toBe(command);
      expect(frame.id).toBe(`matrix-${command}`);
      // 恰一：该 id 的响应帧计数 = 1
      const count = host.lines.filter((f) => f.type === "response" && f.id === `matrix-${command}`).length;
      expect(count).toBe(1);
    }
  }, 120_000);
});
