import { join } from "node:path";
import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { readCatalog, buildAssemblySnapshot, resolveDefaultDial } from "../../apps/host-hub/src/shared/catalog.ts";
import { appendFileSync, writeFileSync } from "node:fs";
const TRACE = "/tmp/realenv-trace.log";
writeFileSync(TRACE, "");
const mark = (m: string): void => { appendFileSync(TRACE, `${new Date().toISOString().slice(11,23)} ${m}\n`); };
import type { ChildProcess } from "node:child_process";

const REPO = "/Users/wrr/work/x-harness";
const AGENT_DIR = "/Users/wrr/.pai/agent";
const SESSION_ID = process.env["PROBE_SESSION_ID"] ?? "20260926T191130-5w75d6";
const CLI = join(REPO, "apps/host-hub/src/host/cli.ts");

const pending = new Map<string, (v: { success: boolean; data?: unknown; error?: unknown }) => void>();
let buffer = Buffer.alloc(0);
let child: ChildProcess | undefined;

function onLine(line: string): void {
  let frame: { type?: unknown; id?: unknown; success?: unknown; data?: unknown; error?: unknown };
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === "hello") return;
  if (typeof frame.id === "string" && pending.has(frame.id)) {
    const resolve = pending.get(frame.id) as (v: { success: boolean; data?: unknown; error?: unknown }) => void;
    pending.delete(frame.id);
    resolve({ success: frame.success === true, data: frame.data, error: frame.error });
  }
}

async function bootWorker(env: Record<string, string>): Promise<{ ms: number }> {
  const began = performance.now();
  child = (await import("node:child_process")).spawn(process.execPath, [CLI, "--internal-worker"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (c: Buffer) => process.stderr.write(`[w] ${c.toString()}`));
  const hello = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(10);
        if (nl < 0) break;
        const line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        if (line.includes('"type":"hello"')) {
          child?.stdout?.off("data", onData);
          resolve();
          return;
        }
        onLine(line);
      }
    };
    child.stdout?.on("data", onData);
  });
  await hello;
  return { ms: performance.now() - began };
}

async function call(id: string, frame: Record<string, unknown>): Promise<{ ms: number; ok: boolean; error?: unknown }> {
  const began = performance.now();
  return await new Promise((resolve) => {
    pending.set(id, (v) => resolve({ ms: performance.now() - began, ok: v.success, error: v.error }));
    void child?.stdin?.write(`${JSON.stringify({ id, ...frame })}\n`);
  });
}

async function main(): Promise<void> {
  mark("begin");
  const sessionsRoot = join(mkdtempSync(join(tmpdir(), "realenv-")), "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  cpSync(join(AGENT_DIR, "sessions", SESSION_ID), join(sessionsRoot, SESSION_ID), { recursive: true });

  mark("copied session");
  const catalog = await readCatalog(AGENT_DIR);
  mark("catalog read");
  const providers = buildAssemblySnapshot(catalog, [], process.env);
  const modelMeta: Record<string, unknown> = {};
  for (const entry of catalog.entries) {
    modelMeta[entry.model] = {
      reasoning: entry.reasoning,
      ...(entry.input !== undefined ? { input: [...entry.input] } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    };
  }
  const defaults = resolveDefaultDial(catalog);
  const snapshot = JSON.stringify({
    providers,
    ...(defaults !== undefined ? { default: defaults } : {}),
    modelMeta,
  });

  mark("snapshot built");
  const env = {
    HUB_AGENT_DIR: AGENT_DIR,
    HUB_SESSIONS_ROOT: sessionsRoot,
    HUB_WORKER_PROVIDERS: snapshot,
  };

  mark("booting worker 1");
  const spawn1 = await bootWorker(env);
  mark(`worker1 hello ${spawn1.ms.toFixed(0)}ms`);
  const fresh = await call("p1", { type: "thread/start", cwd: REPO, trusted: true });
  mark(`thread/start ${fresh.ms.toFixed(0)}ms ok=${fresh.ok}`);
  process.stdout.write(`spawn+hello                       ${spawn1.ms.toFixed(0)}ms\n`);
  process.stdout.write(`thread/start (real assembly)      ${fresh.ms.toFixed(0)}ms ok=${fresh.ok}\n`);
  child?.kill("SIGKILL");
  await new Promise((r) => child?.once("exit", r));

  mark("booting worker 2");
  const spawn2 = await bootWorker(env);
  mark(`worker2 hello ${spawn2.ms.toFixed(0)}ms`);
  const resumed = await call("p2", {
    type: "thread/resume",
    sessionPath: join(sessionsRoot, SESSION_ID, "events.jsonl"),
    trusted: true,
    cwd: REPO,
  });
  process.stdout.write(`spawn+hello                       ${spawn2.ms.toFixed(0)}ms\n`);
  process.stdout.write(`thread/resume (real env)          ${resumed.ms.toFixed(0)}ms ok=${resumed.ok} err=${JSON.stringify(resumed.error ?? null).slice(0, 160)}\n`);

  mark(`thread/resume ${resumed.ms.toFixed(0)}ms ok=${resumed.ok}`);
  const entries = await call("p3", { type: "get_entries", threadId: SESSION_ID, limit: 50 });
  process.stdout.write(`get_entries (in-worker)           ${entries.ms.toFixed(0)}ms ok=${entries.ok}\n`);

  mark("listing saved");
  const listBegan = performance.now();
  const { listSavedSessions } = await import("../../apps/host-hub/src/host/saved-query.ts");
  const rows = await listSavedSessions(AGENT_DIR + "/sessions");
  process.stdout.write(`listSavedSessions (real root)     ${(performance.now() - listBegan).toFixed(0)}ms rows=${rows.length}\n`);

  mark(`listSavedSessions ${(performance.now()-listBegan).toFixed(0)}ms rows=${rows.length}`);
  mark("done");
  child?.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}

void main();
