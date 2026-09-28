// git/changed 事件集成（host 全链：表 live 线程 → git-watch → emitClient 帧出去）。
// 装置沿用 thread-git-branch.test.ts 手驱形态（就绪门/spawn 等待/控制应答）。

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
    if (Date.now() - started > 10_000) throw new Error(`waitResponse timeout for ${command}`);
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 10);
    });
  }
}

/** 等 git/changed 事件帧（threadId 域；1s 对账 + 150ms 防抖余量） */
async function waitGitChanged(client: readonly string[], threadId: string, timeoutMs = 8_000): Promise<{ cwd?: string; branch?: string } | undefined> {
  const started = Date.now();
  for (;;) {
    for (const line of client) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame["type"] === "event" && frame["name"] === "git/changed" && frame["threadId"] === threadId) {
        return frame["payload"] as { cwd?: string; branch?: string };
      }
    }
    if (Date.now() - started > timeoutMs) return undefined;
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 100);
    });
  }
}

async function waitReady(f: { client: string[]; send: (cmd: unknown) => void }): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    f.send({ type: "thread/list", id: `ready-${attempt}` });
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 25);
    });
    if (f.client.some((line) => line.includes(`"id":"ready-${attempt}"`))) return;
  }
  throw new Error("host not ready in 5s");
}

test("host 全链：外部 switch → git/changed 事件帧（payload cwd+branch，threadId 域）", async () => {
  // 真 git 仓（独立分支——避免 worktree 语义干扰首例）
  const parent = await tempDir("hub-gc-repo-p-");
  const repo = join(parent, "repo");
  await mkdir(repo);
  await exec("git", ["-C", repo, "init"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "seed\n");
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", ["-C", repo, "commit", "-m", "seed"]);

  const agentDir = await tempDir("hub-gc-");
  const sessionsRoot = join(agentDir, "sessions");
  const input = new FakeInput();
  const client: string[] = [];
  const workers: Array<{ written: string[]; onLine: (line: string) => void; hello: () => void }> = [];
  void runHost({
    homeDir: await tempDir("hub-gc-home-"),
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
  const send = (cmd: unknown): void => input.send(cmd);
  await waitReady({ client, send });

  // 起 live 线程（cwd=repo）
  send({ type: "thread/start", id: "s1", cwd: repo });
  const started = Date.now();
  let worker: (typeof workers)[number] | undefined;
  while (worker === undefined && Date.now() - started < 10_000) {
    worker = workers[workers.length - 1];
    if (worker === undefined || !worker.written.some((line) => line.includes('"thread/start"'))) {
      worker = undefined;
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 10);
      });
    }
  }
  if (worker === undefined) throw new Error("worker not spawned");
  worker.hello();
  const threadId = "t-s1";
  worker.onLine(responseLine({ id: "s1", command: "thread/start", success: true, data: { threadId, cwd: repo, sessionPath: `${sessionsRoot}/${threadId}/events.jsonl` } }));

  // 外部 switch（1s 对账挂 watcher 前等待）
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 1_500);
  });
  await exec("git", ["-C", repo, "checkout", "-b", "feat/evt"]);

  const payload = await waitGitChanged(client, threadId);
  expect(payload).toBeDefined();
  expect(payload?.branch).toBe("feat/evt");
  expect(payload?.cwd).toBe(repo);

  send({ type: "thread/stop", id: "sp1", threadId });
  await waitResponse(client, "thread/stop", "sp1");
}, 30_000);
