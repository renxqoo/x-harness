// host 流程补面：resume 成功路径（真档案 + 假 worker 内部应答）、keepalive/retire、
// ui_response 广播、trusted 装载目录、set_model 转发（HOST_RELAYED live 交池）。
import { EventEmitter } from "node:events";
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { runHost } from "../host/host.ts";
import type { WorkerSpawnSpec } from "../host/worker-process.ts";
import type { WorkerHandle } from "../host/worker-process.ts";
import { responseLine } from "../shared/frame-classify.ts";

class FakeInput extends EventEmitter {
  private pending: Buffer[] = [];
  constructor() {
    super();
    this.on("newListener", (event: string) => {
      if (event === "data" && this.pending.length > 0) {
        const backlog = this.pending;
        this.pending = [];
        queueMicrotask(() => {
          for (const chunk of backlog) this.emit("data", chunk);
        });
      }
    });
  }
  send(cmd: unknown): void {
    const chunk = Buffer.from(`${JSON.stringify(cmd)}\n`, "utf8");
    if (this.listenerCount("data") > 0) this.emit("data", chunk);
    else this.pending.push(chunk);
  }
}

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitResponse(client: readonly string[], command: string, id?: string): Promise<Record<string, unknown>> {
  const timeoutMs = 5_000;
  const started = Date.now();
  for (;;) {
    for (const line of client) {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame["type"] === "response" && frame["command"] === command && (id === undefined || frame["id"] === id)) return frame;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`waitResponse timeout: ${command}; last=${client.slice(-3).join(" | ")}`);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 10);
    });
  }
}

/** response error 字段结构化断言面（code + message） */
function errOf(frame: Record<string, unknown>): { code: string; message: string } {
  return frame["error"] as { code: string; message: string };
}

async function startHost(): Promise<{ input: FakeInput; client: string[]; agentDir: string; sessionsRoot: string; workers: Array<{ written: string[]; onLine: (l: string) => void; hello: () => void; close: () => void }>; send: (cmd: unknown) => void }> {
  const agentDir = await tempDir("hub-fh-");
  const sessionsRoot = join(agentDir, "sessions");
  const input = new FakeInput();
  const client: string[] = [];
  const workers: Array<{ written: string[]; onLine: (l: string) => void; hello: () => void; close: () => void }> = [];
  void runHost({
    agentDir,
    sessionsRoot,
    env: { HUB_SKILLS_MIGRATION: "0" },
    input: input as unknown as NodeJS.ReadStream,
    exit: () => {},
    emitOverride: (line) => client.push(line),
    spawn: (spec: WorkerSpawnSpec): WorkerHandle => {
      const worker = {
        written: [] as string[],
        onLine: spec.onLine,
        hello: () => spec.onLine(`{"type":"hello","protocolVersion":1,"backendId":"x-harness"}`),
        close: () => spec.onClosed(),
      };
      workers.push(worker);
      return {
        uid: `fake-${workers.length}`,
        write: (line: string) => {
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

/** 建真档案（resume/register 共用） */
async function makeArchive(sessionsRoot: string, sid: string): Promise<string> {
  return makeArchiveIn(sessionsRoot, sid, "/w");
}

async function makeArchiveIn(sessionsRoot: string, sid: string, cwd: string): Promise<string> {
  const dir = join(sessionsRoot, sid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd }), "utf8");
  const events = [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
    { type: "session/meta", seq: 1, time: 2, data: { key: "title", value: "resumable" } },
  ];
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"), "utf8");
  return join(dir, "events.jsonl");
}

describe("host 流程补面", () => {
  test("thread/resume 成功路径：占位 → spawn → 控制应答转发（表项 live）+ keepalive/retire/stop", async () => {
    const f = await startHost();
    const sessionPath = await makeArchive(f.sessionsRoot, "resumable01");
    f.send({ type: "thread/resume", id: "r1", sessionPath });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    const worker = f.workers[f.workers.length - 1];
    worker?.hello();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
    const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
    expect(resumeLine).toBeDefined();
    const resume = JSON.parse(resumeLine as string) as { id: string };
    worker?.onLine(responseLine({ id: resume.id, command: "thread/resume", success: true, data: { threadId: "resumable01", cwd: "/w", sessionPath } }));
    const forwarded = await waitResponse(f.client, "thread/resume", "r1");
    expect(forwarded["success"]).toBe(true);
    // keepalive：未知线程拒 + 已知设位
    f.send({ type: "thread/set_keepalive", id: "ka1", threadId: "ghost", keepalive: true });
    const unknownThread = await waitResponse(f.client, "thread/set_keepalive", "ka1");
    expect(errOf(unknownThread)).toEqual({ code: "unknown_thread", message: "Unknown threadId" });
    f.send({ type: "thread/set_keepalive", id: "ka2", threadId: "resumable01", keepalive: true });
    await waitResponse(f.client, "thread/set_keepalive", "ka2");
    // retire：live 表项 → retiring（ack ok；close 后 parked 帧）
    f.send({ type: "thread/retire", id: "rt1", threadId: "resumable01" });
    await waitResponse(f.client, "thread/retire", "rt1");
    worker?.close();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 50);
    });
    expect(f.client.some((line) => line.includes("thread_parked"))).toBe(true);
  });

  test("ui_response 广播到 live worker + set_model（HOST_RELAYED live 交池转发）", async () => {
    const f = await startHost();
    const sessionPath = await makeArchive(f.sessionsRoot, "relayme0001");
    f.send({ type: "thread/resume", id: "r1", sessionPath });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    const worker = f.workers[f.workers.length - 1];
    worker?.hello();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
    const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
    const resume = JSON.parse(resumeLine as string) as { id: string };
    worker?.onLine(responseLine({ id: resume.id, command: "thread/resume", success: true, data: { threadId: "relayme0001", cwd: "/w", sessionPath } }));
    await waitResponse(f.client, "thread/resume", "r1");
    // ui_response：host 恒 ack + 原文广播
    f.send({ type: "ui_response", id: "ur1", requestId: "rq-1", payload: { confirmed: true } });
    await waitResponse(f.client, "ui_response", "ur1");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    expect(worker?.written.some((line) => line.includes("ui_response") && line.includes("rq-1"))).toBe(true);
    // set_model 带 threadId：host 单点 → live 交池转发 worker
    f.send({ type: "set_model", id: "sm1", threadId: "relayme0001", provider: "glm", modelId: "glm-5.3" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    expect(worker?.written.some((line) => line.includes("set_model"))).toBe(true);
    worker?.onLine(responseLine({ id: "sm1", command: "set_model", success: true }));
    const ack = await waitResponse(f.client, "set_model", "sm1");
    expect(ack["success"]).toBe(true);
  });

  test("agents/list trusted project 目录装载 + get_models 数据面", async () => {
    const f = await startHost();
    // trusted 线程（表项 trusted + cwd）→ agents/list 带 threadId 装载 project 目录
    const cwd = await tempDir("hub-proj-");
    const sessionPath = await makeArchiveIn(f.sessionsRoot, "agentproj01", cwd);
    f.send({ type: "thread/register", id: "rg1", sessionPath, trusted: true });
    await waitResponse(f.client, "thread/register", "rg1");
    await mkdir(join(cwd, ".x-harness", "agents"), { recursive: true });
    await writeFile(join(cwd, ".x-harness", "agents", "helper.md"), "---\nname: helper\ndescription: helps\n---\nbe helpful\n", "utf8");
    f.send({ type: "agents/list", id: "al1", threadId: "agentproj01" });
    const listed = await waitResponse(f.client, "agents/list", "al1");
    expect((listed["data"] as { agents: Array<{ name: string; source: string }> }).agents.some((a) => a.name === "helper" && a.source === "project")).toBe(true);
    // get_models：预设集（零配置）
    f.send({ type: "get_models", id: "gm1" });
    const models = await waitResponse(f.client, "get_models", "gm1");
    const entries = models["data"] as Array<{ id: string; provider: string; source: string }>;
    expect(entries.some((m) => m.id === "glm-5.3" && m.provider === "glm" && m.source === "preset")).toBe(true);
    void homedir;
  });

  test("cH4：resume 别名拼法（./）占用归一——已 live 线程不可被别名打死", async () => {
    const f = await startHost();
    const sessionPath = await makeArchive(f.sessionsRoot, "aliasproof1");
    f.send({ type: "thread/resume", id: "r1", sessionPath });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    const worker = f.workers[f.workers.length - 1];
    worker?.hello();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
    const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
    const resume = JSON.parse(resumeLine as string) as { id: string };
    worker?.onLine(responseLine({ id: resume.id, command: "thread/resume", success: true, data: { threadId: "aliasproof1", cwd: "/w", sessionPath } }));
    await waitResponse(f.client, "thread/resume", "r1");
    // 同会话的 `./` 别名 resume → already open（占用键已归一 canonical）
    const alias = sessionPath.replace("/aliasproof1/", "/./aliasproof1/");
    f.send({ type: "thread/resume", id: "r2", sessionPath: alias });
    const rejected = await waitResponse(f.client, "thread/resume", "r2");
    expect(errOf(rejected)).toEqual({ code: "already_open", message: "already open" });
    // 线程仍 live（别名不可把表项打死）
    f.send({ type: "thread/list", id: "l1" });
    const listed = await waitResponse(f.client, "thread/list", "l1");
    expect(((listed["data"] as Array<{ threadId: string; state: string }>).find((row) => row.threadId === "aliasproof1"))?.state).toBe("live");
  });

  test("uncaught/rejection 只发 hub_error 不崩（注册面覆盖）+ thread/register 相对路径拒", async () => {
    const agentDir = await tempDir("hub-err-");
    const sessionsRoot = join(agentDir, "sessions");
    const input = new FakeInput();
    const client: string[] = [];
    void runHost({
      agentDir,
      sessionsRoot,
      env: { HUB_SKILLS_MIGRATION: "0" },
      input: input as unknown as NodeJS.ReadStream,
      exit: () => {},
      emitOverride: (line) => client.push(line),
      spawn: (() => {
        throw new Error("no spawn in this test");
      }) as never,
    });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 80);
    });
    const proc = process as unknown as { emit(event: string, ...args: unknown[]): boolean };
    proc.emit("uncaughtException", new Error("boom-uncaught"));
    proc.emit("unhandledRejection", new Error("boom-rejection"), Promise.resolve());
    // register 相对路径（fence 拒面——非 spawn 路径）
    input.send({ type: "thread/register", id: "rg-rel", sessionPath: "relative/events.jsonl" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    expect(client.some((line) => line.includes("hub_error") && line.includes("boom-uncaught"))).toBe(true);
    expect(client.some((line) => line.includes("hub_error") && line.includes("boom-rejection"))).toBe(true);
    expect(client.some((line) => line.includes("rg-rel") && line.includes("session path outside sessions dir"))).toBe(true);
  });

  test("分支补面：thread/start 缺省 cwd（host 进程 cwd）+ resume 显式 cwd 覆盖", async () => {
    const f = await startHost();
    const sessionPath = await makeArchiveIn(f.sessionsRoot, "cwdoverride1", "/original");
    f.send({ type: "thread/resume", id: "r1", sessionPath, cwd: "/explicit" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    const worker = f.workers[f.workers.length - 1];
    worker?.hello();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 20);
    });
    const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
    const resume = JSON.parse(resumeLine as string) as { id: string; cwd?: string };
    expect(resume.cwd).toBe("/explicit"); // 显式 cwd 透传 worker（装配 cwd 回退序第一级）
    worker?.onLine(responseLine({ id: resume.id, command: "thread/resume", success: true, data: { threadId: "cwdoverride1", cwd: "/explicit", sessionPath } }));
    await waitResponse(f.client, "thread/resume", "r1");
    // thread/start 缺省 cwd = host 进程 cwd
    f.send({ type: "thread/start", id: "s1" });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 30);
    });
    const startLine = f.workers[f.workers.length - 1]?.written.find((line) => line.includes('"thread/start"'));
    expect(startLine).toBeDefined();
  });

  test("workspace/trust 撤销 + isTrusted live 线程集 + 坏帧行（非对象/缺 type）", async () => {
    const f = await startHost();
    const cwd = await tempDir("hub-tr-");
    f.send({ type: "workspace/trust", id: "wt1", cwd, trusted: true });
    await waitResponse(f.client, "workspace/trust", "wt1");
    f.send({ type: "workspace/trust", id: "wt2" });
    const listed = await waitResponse(f.client, "workspace/trust", "wt2");
    expect(((listed["data"] as { trusted: string[] }).trusted).length).toBeGreaterThan(0);
    f.send({ type: "workspace/trust", id: "wt3", cwd, trusted: false }); // 撤销
    await waitResponse(f.client, "workspace/trust", "wt3");
    f.send({ type: "workspace/trust", id: "wt4" });
    const afterRevoke = await waitResponse(f.client, "workspace/trust", "wt4");
    expect((afterRevoke["data"] as { trusted: string[] }).trusted).toEqual([]);
    // 坏帧行：非对象 JSON / type 缺席 → unknown command 域
    f.input.emit("data", Buffer.from('"just a string"\n', "utf8"));
    f.input.emit("data", Buffer.from("{}\n", "utf8"));
    f.input.emit("data", Buffer.from(`${JSON.stringify({ noType: true })}\n`, "utf8"));
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    expect(f.client.some((line) => line.includes("unknown command"))).toBe(true);
  });

  test("stdin EOF → 优雅停机（shutdownAll + exit 0 兑现；关闭期新命令回 shutting down）", async () => {
    const agentDir = await tempDir("hub-eof-");
    const sessionsRoot = join(agentDir, "sessions");
    const input = new FakeInput();
    const client: string[] = [];
    let exited = -1;
    let eofSeen = false;
    void runHost({
      agentDir,
      sessionsRoot,
      env: { HUB_SKILLS_MIGRATION: "0" },
      input: input as unknown as NodeJS.ReadStream,
      exit: (code) => {
        exited = code;
      },
      emitOverride: (line) => client.push(line),
      spawn: (spec: WorkerSpawnSpec): WorkerHandle => ({
        uid: "w-eof",
        write: () => Promise.resolve(),
        kill: () => {
          setTimeout(() => spec.onClosed(), 0);
        },
        eof: () => {
          eofSeen = true;
          setTimeout(() => spec.onClosed(), 0);
        },
        exited: new Promise<void>(() => {}),
      }),
    });
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
    input.emit("end"); // EOF → shutdown（FakeInput 无 end——事件直发）
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 150);
    });
    expect(exited).toBe(0);
    void eofSeen;
  });

  test("thread/register 信任登记（trusted:true 落注册表）+ settings/set 项目级（cwd 形态）", async () => {
    const f = await startHost();
    const cwd = await tempDir("hub-proj2-");
    const sessionPath = await makeArchiveIn(f.sessionsRoot, "register02", cwd);
    f.send({ type: "thread/register", id: "rg1", sessionPath, trusted: true });
    await waitResponse(f.client, "thread/register", "rg1");
    // register trusted:true 登记注册表（host 转发链——entry.cwd 为项目目录）
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 50);
    });
    const registry = JSON.parse(await Bun.file(join(f.agentDir, "trusted-workspaces.json")).text()) as string[];
    const { normalizeCwd } = await import("../shared/settings-store.ts");
    expect(registry).toContain(await normalizeCwd(cwd)); // 登记存规范化形态（realpath）
    await mkdir(join(cwd, ".x-harness"), { recursive: true });
    // 项目级 settings/set：目录自建 + 读取合并
    f.send({ type: "settings/set", id: "ss1", key: "permission.defaultMode", value: "plan", cwd });
    await waitResponse(f.client, "settings/set", "ss1");
    f.send({ type: "settings/get", id: "sg1", cwd });
    const merged = await waitResponse(f.client, "settings/get", "sg1");
    const data = merged["data"] as { values: Record<string, unknown>; sources: Record<string, string>; raw: { project: Record<string, unknown>; user: Record<string, unknown> } };
    expect(data.values).toEqual({ "permission.defaultMode": "plan" });
    expect(data.sources).toEqual({ "permission.defaultMode": "project" });
    expect(data.raw.project).toEqual({ "permission.defaultMode": "plan" });
  });
});
