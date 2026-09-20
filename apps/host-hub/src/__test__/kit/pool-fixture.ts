// host 池装置（MIGRATION §5 pool-fixture 移植）：fakeSpawnFactory 注入缝——假
// worker 句柄（手驱 hello/响应/close），真 thread-table + 真 worker-pool。
import { createThreadTable } from "../../host/thread-table.ts";
import { createWorkerPool } from "../../host/worker-pool.ts";
import type { WorkerHandle, WorkerSpawnSpec } from "../../host/worker-process.ts";
import type { WorkerPool } from "../../host/worker-pool.ts";
import type { ThreadTable } from "../../host/thread-table.ts";

export interface FakeWorkerSpec {
  uid: string;
  written: string[];
  onLine: (line: string) => void;
  helloOk: () => void;
  close: () => void;
  kill: () => void;
  eof: () => void;
}

export function fakeSpawnFactory() {
  const spawned: FakeWorkerSpec[] = [];
  const spawn = (spec: WorkerSpawnSpec): WorkerHandle => {
    let resolveExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const settle = (): void => {
      spec.onClosed();
      resolveExited();
    };
    const spec_: FakeWorkerSpec = {
      uid: `fake-${spawned.length + 1}`,
      written: [],
      onLine: spec.onLine,
      helloOk: () => spec.onLine(`{"type":"hello","protocolVersion":1,"backendId":"x-harness"}`),
      close: () => settle(),
      kill: () => {
        setTimeout(() => settle(), 0);
      },
      eof: () => {
        setTimeout(() => settle(), 0);
      },
    };
    spawned.push(spec_);
    return {
      uid: spec_.uid,
      write: (line: string) => {
        spec_.written.push(line);
        return Promise.resolve();
      },
      kill: (_graceMs: number) => spec_.kill(),
      eof: () => spec_.eof(),
      exited,
    };
  };
  return { spawned, spawn };
}

export interface PoolFixture {
  table: ThreadTable;
  pool: WorkerPool;
  client: string[];
  spawned: FakeWorkerSpec[];
}

export function makePool(maxThreads = 8, over: { workerEnv?: () => Record<string, string>; workerExitTimeoutMs?: number } = {}): PoolFixture {
  const client: string[] = [];
  const table = createThreadTable();
  const fake = fakeSpawnFactory();
  const pool = createWorkerPool({
    table,
    emitClient: (line) => client.push(line),
    limits: { maxThreads, workerExitTimeoutMs: over.workerExitTimeoutMs ?? 50 },
    workerEnv: over.workerEnv ?? (() => ({ HUB_AGENT_DIR: "/hub", HUB_SESSIONS_ROOT: "/hub/sessions" })),
    spawn: fake.spawn as never,
  });
  return { table, pool, client, spawned: fake.spawned };
}

/** written 断言 helper（until 谓词工厂——降嵌套层级） */
export function wrote(worker: { written: readonly string[] } | undefined, needle: string): () => boolean {
  return () => (worker?.written.some((line) => line.includes(needle)) ?? false);
}

/** spawned 中首个含未决 resume 且未见过的 worker 查询 */
export function withPendingResume(f: PoolFixture, seen: ReadonlySet<string>): FakeWorkerSpec | undefined {
  return f.spawned.find((w) => !seen.has(w.uid) && w.written.some((line) => line.includes('"thread/resume"')));
}

/** client 帧断言 helper（until 谓词工厂） */
export function clientHas(client: readonly string[], needle: string): () => boolean {
  return () => client.some((line) => line.includes(needle));
}

export async function until(pred: () => boolean, label = "until", timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** 唤醒投递基元：routeLine → spawn → hello → resume 应答 → 投递完成 */
export async function wakeAndDeliver(f: PoolFixture, command: { type: string; id?: string; threadId?: string }): Promise<void> {
  const before = f.spawned.length;
  void f.pool.routeLine(JSON.stringify(command));
  await until(() => f.spawned.length > before, "spawn");
  const worker = f.spawned[f.spawned.length - 1];
  worker?.helloOk();
  const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
  if (resumeLine !== undefined) {
    const resume = JSON.parse(resumeLine) as { id: string; sessionPath: string };
    worker?.onLine(`{"id":${JSON.stringify(resume.id)},"type":"response","command":"thread/resume","success":true,"data":{"threadId":${JSON.stringify(command.threadId ?? "")},"cwd":"/w","sessionPath":${JSON.stringify(resume.sessionPath)}}}`);
  }
  await until(() => (f.spawned[f.spawned.length - 1]?.written.some((line) => line.includes(JSON.stringify(command.type))) ?? false), "deliver");
}
