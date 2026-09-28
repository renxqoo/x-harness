// 红测（对抗审查——host-hub 面）：thread/list 的 gitBranch 现算锚 entry.cwd 存在
// 「未归一相对路径」脏边（host-commands.ts reserveResumeSlot 落表 raw input.cwd，
// WORKTREE-CONTEXT-AWARENESS §1.5 自认落档）。提交注释与文档宣称该脏边「经
// probeGitFacts 存在性前置 + 键省略降级」（host-commands.ts:297）——但存在性前置
// 只挡「cwd 不存在」；相对路径在宿主进程 cwd 下**存在**时 resolve() 反而把它锚到
// 宿主 cwd，向上游走命中宿主自己的仓 → 展示**与线程毫无关系的分支**（非键省略）。
//
// 两个形态：
// ① 占位窗口（spawning）——脏 cwd 已落表，list 即现错分支；
// ② resume 失败 → dead 残留——错分支长期驻留（每次 list 重现）。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** 等 host 就绪（thread/list 应答为就绪信号——冷启动竞态消除，先例 thread-git-branch.test） */
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

async function startHost(): Promise<HostFixture> {
  const agentDir = await tempDir("hub-gbred-");
  const sessionsRoot = join(agentDir, "sessions");
  const input = new FakeInput();
  const client: string[] = [];
  const workers: HostFixture["workers"] = [];
  void runHost({
    homeDir: await tempDir("hub-gbred-home-"),
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

/** 宿主进程 cwd 用的真 git 仓（分支名刻意可识别——非本仓、非 main） */
async function hostCwdRepo(): Promise<string> {
  const parent = await tempDir("hub-gbred-repo-p-");
  const dir = join(parent, "repo");
  await mkdir(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  await exec("git", ["-C", dir, "checkout", "-b", "hostrepo/dotfiles"]);
  return dir;
}

/** 可恢复档案：header.cwd 指向仓外普通目录（会话事实与宿主仓无关） */
async function makeArchive(f: HostFixture, sid: string, cwd: string | undefined): Promise<string> {
  const dir = join(f.sessionsRoot, sid);
  await mkdir(dir, { recursive: true });
  const header: Record<string, unknown> = { id: sid, createdAt: 1 };
  if (cwd !== undefined && cwd !== "") header["cwd"] = cwd;
  await writeFile(join(dir, "header.json"), JSON.stringify(header), "utf8");
  await writeFile(join(dir, "events.jsonl"), `${JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } })}\n`, "utf8");
  return join(dir, "events.jsonl");
}

const gitBranchOf = (frame: Record<string, unknown>, threadId: string): string | undefined =>
  ((frame["data"] as Array<{ threadId: string; gitBranch?: string }>) ?? []).find((r) => r.threadId === threadId)?.gitBranch;

describe("红测：thread/list gitBranch 锚相对 cwd —— 宿主仓分支被冒充为线程分支", () => {
  const previousCwd = process.cwd();
  let hostCwd: string | undefined;

  beforeAll(async () => {
    hostCwd = await hostCwdRepo();
    // 宿主进程 cwd = 真 git 仓（GUI 拉起 hub 的现实形态之一；也是 probeGitFacts 相对
    // 路径 resolve() 的锚）
    process.chdir(hostCwd);
    // 相对路径目标目录须在场（存在性前置通过——文档宣称的降级防线即失守）
    await mkdir(join(hostCwd, "relwork"), { recursive: true });
  });

  afterEach(async () => {
    if (hostCwd !== undefined) await exec("git", ["-C", hostCwd, "worktree", "prune"]).catch(() => {});
  });

  afterAll(() => {
    process.chdir(previousCwd);
  });

  test("resume 不带 cwd + 坏档无 header.cwd → 占位兜底宿主 process.cwd() → dead 残留冒充宿主仓分支", async () => {
    const f = await startHost();
    await waitReady(f);
    // 坏档：header 无 cwd 字段（旧档/外部产档现实形态）——preReadCwd undefined → worker 侧
    // 回退自身 state.cwd（= 宿主 cwd）；host 侧占位 insert 兜底 process.cwd()（host-commands.ts:150）
    const sessionPath = await makeArchive(f, "fallbackcwd1", "");
    f.send({ type: "thread/resume", id: "r1", sessionPath }); // 不带 cwd 入参
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const worker = f.workers[f.workers.length - 1];
    if (worker === undefined) throw new Error("worker not spawned");
    worker.hello();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    const resumeLine = worker.written.find((line) => line.includes("thread/resume"));
    const resumeId = (JSON.parse(resumeLine as string) as { id: string }).id;
    worker.onLine(responseLine({ id: resumeId, command: "thread/resume", success: false, error: { code: "session_unreadable", message: "Session file not readable" } }));
    await waitResponse(f.client, "thread/resume", "r1");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    // 期望：无 cwd 事实的线程不得展示任何分支（键省略）。现状红：宿主 cwd 仓分支冒充。
    expect(gitBranchOf(list, "fallbackcwd1")).toBeUndefined();
  }, 20_000);

  test("resume 传相对 cwd → 表项落 raw 相对串 → list 现算命中宿主仓分支（应键省略）", async () => {
    const f = await startHost();
    await waitReady(f);
    const sessionPath = await makeArchive(f, "relcwdtest1", "/definitely/not/a/repo");
    // reserveResumeSlot 落表：cwd = "relwork"（raw、未归一——host-commands.ts:150）
    f.send({ type: "thread/resume", id: "r1", sessionPath, cwd: "relwork" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const worker = f.workers[f.workers.length - 1];
    if (worker === undefined) throw new Error("worker not spawned");
    f.send({ type: "thread/list", id: "l1" });
    const list = await waitResponse(f.client, "thread/list", "l1");
    // 期望（提交自述的降级语义 host-commands.ts:297「脏边经存在性前置 + 键省略降级」）：
    // 未归一相对 cwd 不得产出分支。现状红：resolve("relwork") 锚到宿主 cwd（真仓）→
    // 游走命中宿主 dotfiles 仓 → 线程行冒充显示 hostrepo/dotfiles。
    expect(gitBranchOf(list, "relcwdtest1")).toBeUndefined();
  }, 20_000);

  test("resume 失败 → dead 残留同款脏 cwd → 错分支长期驻留（每次 list 重现）", async () => {
    const f = await startHost();
    await waitReady(f);
    const sessionPath = await makeArchive(f, "relcwdtest2", "/definitely/not/a/repo");
    f.send({ type: "thread/resume", id: "r1", sessionPath, cwd: "relwork" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const worker = f.workers[f.workers.length - 1];
    if (worker === undefined) throw new Error("worker not spawned");
    worker.hello();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    const resumeLine = worker.written.find((line) => line.includes('"thread/resume"'.replace(/\\/g, "")));
    const resumeId = (JSON.parse(resumeLine as string) as { id: string }).id;
    // worker 拒（session 坏档等现实失败面）→ host kill + dead 结算；表项残留 raw cwd
    worker.onLine(responseLine({ id: resumeId, command: "thread/resume", success: false, error: { code: "session_unreadable", message: "Session file not readable" } }));
    await waitResponse(f.client, "thread/resume", "r1");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    const dead = f.client.some((line) => line.includes("thread_died") && line.includes("relcwdtest2"));
    expect(dead).toBe(true); // dead 结算在场（残留前提）
    f.send({ type: "thread/list", id: "l2" });
    const list = await waitResponse(f.client, "thread/list", "l2");
    expect(gitBranchOf(list, "relcwdtest2")).toBeUndefined(); // 现状红：hostrepo/dotfiles
  }, 20_000);
});
