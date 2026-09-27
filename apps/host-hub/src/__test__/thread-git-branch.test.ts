// thread/list gitBranch 现算 + thread/start 响应 gitBranch（docs/WORKTREE-CONTEXT-
// AWARENESS §1.5 协议面）：真 git 夹具（git -C 显式——host-hub 首例，照抄
// agent-delegation worktree.test 口径）；detached 键省略；同仓同分支 list 与 start
// 一致性锚（防两源漂移——list 现算 vs start 装配期）。

import { afterAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { runHost } from "../host/host.ts";
import type { WorkerSpawnSpec } from "../host/worker-process.ts";
import type { WorkerHandle } from "../host/worker-process.ts";
import { responseLine } from "../shared/frame-classify.ts";

const exec = promisify(execFile);

class FakeInput extends EventEmitter {
  send(cmd: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify(cmd)}\n`, "utf8"));
  }
}

interface HostFixture {
  readonly input: FakeInput;
  readonly client: string[];
  readonly agentDir: string;
  readonly sessionsRoot: string;
  readonly workers: Array<{ written: string[]; onLine: (line: string) => void; hello: () => void }>;
  send(cmd: unknown): void;
}

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function waitResponse(client: readonly string[], command: string, id?: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    for (const line of client) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame["type"] === "response" && frame["command"] === command && (id === undefined || frame["id"] === id)) return frame;
    }
    if (Date.now() - started > 10_000) throw new Error(`waitResponse timeout for ${command}; frames: ${client.join(" | ").slice(0, 400)}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** 等待 host 异步装配就绪（命令路由可达——runHost 的 ensureAgentDir/迁移期输入事件
 *  会丢；以 thread/list 应答为就绪信号再发 start，消除冷启动竞态） */
async function waitReady(f: HostFixture): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    f.send({ type: "thread/list", id: `ready-${attempt}` });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    if (f.client.some((line) => line.includes(`"id":"ready-${attempt}"`))) return;
  }
  throw new Error("host not ready in 5s");
}

/** 等待 spawn 出现（beginThread 后 worker 才在场——hello 手驱的前提） */
async function waitWorker(f: HostFixture): Promise<HostFixture["workers"][number]> {
  const started = Date.now();
  for (;;) {
    const worker = f.workers[f.workers.length - 1];
    if (worker !== undefined && worker.written.some((line) => line.includes('"thread/start"'))) return worker;
    if (Date.now() - started > 10_000) throw new Error(`worker not spawned; workers=${String(f.workers.length)}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function startHost(): Promise<HostFixture> {
  const agentDir = await tempDir("hub-gb-");
  const sessionsRoot = join(agentDir, "sessions");
  const input = new FakeInput();
  const client: string[] = [];
  const workers: HostFixture["workers"] = [];
  void runHost({
    homeDir: await tempDir("hub-gb-home-"),
    agentDir,
    sessionsRoot,
    env: { HUB_SKILLS_MIGRATION: "0", HUB_AGENTS_MIGRATION: "0" },
    input: input as unknown as NodeJS.ReadStream,
    exit: () => {},
    emitOverride: (line) => client.push(line),
    spawn: (spec: WorkerSpawnSpec): WorkerHandle => {
      const worker = { written: [] as string[], onLine: spec.onLine, hello: () => spec.onLine(`{"type":"hello","protocolVersion":1,"backendId":"x-harness"}`) };
      workers.push(worker);
      return {
        uid: `fake-${workers.length}`,
        write: (line) => {
          worker.written.push(line);
          return Promise.resolve();
        },
        kill: () => {
          setTimeout(() => spec.onClosed(), 0);
        },
        eof: () => {
          setTimeout(() => spec.onClosed(), 0);
        },
        exited: new Promise<void>(() => {}),
      };
    },
  });
  return { input, client, agentDir, sessionsRoot, workers, send: (cmd) => input.send(cmd) };
}

/** 真 git 仓夹具（git -C 显式——无 ambient cwd 依赖） */
async function gitRepo(): Promise<string> {
  const parent = await tempDir("hub-gb-repo-p-");
  const dir = join(parent, "repo");
  await mkdir(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  await exec("git", ["-C", dir, "checkout", "-b", "feat/gb"]);
  return dir;
}

/** thread/start 手驱（就绪门 + spawn 等待）：返回 threadId */
async function driveStart(f: HostFixture, spec: { readonly id: string; readonly cwd: string; readonly data?: Record<string, unknown> }): Promise<string> {
  await waitReady(f);
  f.send({ type: "thread/start", id: spec.id, cwd: spec.cwd });
  const worker = await waitWorker(f);
  worker.hello();
  const threadId = `t-${spec.id}`;
  worker.onLine(responseLine({ id: spec.id, command: "thread/start", success: true, data: { threadId, cwd: spec.cwd, sessionPath: `${f.sessionsRoot}/${threadId}/events.jsonl`, ...spec.data } }));
  return threadId;
}

describe("thread/list gitBranch 现算（D3——分支易变不落账）", () => {
  test("git 仓 cwd → gitBranch 在场；切分支后 list 跟随（自动切换语义）；与 start 装配位值一致（同源锚）", async () => {
    const repo = await gitRepo();
    const f = await startHost();
    const threadId = await driveStart(f, { id: "s1", cwd: repo, data: { gitBranch: "feat/gb" } });
    const started = await waitResponse(f.client, "thread/start", "s1");
    expect((started["data"] as { gitBranch?: string }).gitBranch).toBe("feat/gb"); // worker 装配位点经 host 转发透传
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    const row = (list["data"] as Array<{ threadId: string; gitBranch?: string }>).find((r) => r.threadId === threadId);
    expect(row?.gitBranch).toBe("feat/gb"); // list 现算 == start 装配值（一致性锚——两源不漂移）
    // 分支切换 → 现算面跟随（不落账的兑现）
    await exec("git", ["-C", repo, "checkout", "main"]).catch(() => exec("git", ["-C", repo, "checkout", "master"]));
    f.send({ type: "thread/list", id: "l2" });
    const list2 = await waitResponse(f.client, "thread/list", "l2");
    const row2 = (list2["data"] as Array<{ threadId: string; gitBranch?: string }>).find((r) => r.threadId === threadId);
    expect(["main", "master"]).toContain(row2?.gitBranch);
    f.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(f.client, "thread/stop", "sp1");
  }, 20_000);

  test("detached → 键省略（D7 降级——不炸不误报）", async () => {
    const repo = await gitRepo();
    await exec("git", ["-C", repo, "checkout", "--detach"]);
    const f = await startHost();
    const threadId = await driveStart(f, { id: "s1", cwd: repo });
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    const row = (list["data"] as Array<{ threadId: string; gitBranch?: string }>).find((r) => r.threadId === threadId);
    expect(row?.gitBranch).toBeUndefined(); // detached → 键省略
    f.send({ type: "thread/stop", id: "sp1", threadId });
    await waitResponse(f.client, "thread/stop", "sp1");
  }, 20_000);
});
