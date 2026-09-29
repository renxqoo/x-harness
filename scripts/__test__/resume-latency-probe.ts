import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = "/Users/wrr/work/x-harness";
const SESSION_SRC = process.env["PROBE_SESSION"] ?? "/Users/wrr/.pai/agent/sessions/20260926T191130-5w75d6";
const EXEC = { command: process.execPath, args: [join(REPO, "apps/host-hub/src/host/cli.ts"), "--internal-worker"] };

let t0 = performance.now();
const mark = (label: string): void => {
  const now = performance.now();
  process.stdout.write(`${label.padEnd(58)} +${((now - t0) / 1000).toFixed(2)}s\n`);
  t0 = now;
};

const lineOf = (obj: unknown): string => JSON.stringify(obj) + "\n";

interface Pending {
  resolve: (v: { success: boolean; data?: unknown; error?: unknown }) => void;
}
const pending = new Map<string, Pending>();
let helloOk = false;
let buffer = Buffer.alloc(0);
let child: ReturnType<typeof import("node:child_process").spawn> | undefined;

function parseFrame(line: string): void {
  let frame: { type?: unknown; id?: unknown; success?: unknown; data?: unknown; error?: unknown };
  try {
    frame = JSON.parse(line) as typeof frame;
  } catch {
    return;
  }
  if (frame.type === "hello") {
    helloOk = true;
    return;
  }
  if (typeof frame.id === "string" && pending.has(frame.id)) {
    const p = pending.get(frame.id) as Pending;
    pending.delete(frame.id);
    p.resolve({ success: frame.success === true, data: frame.data, error: frame.error });
  }
}

async function main(): Promise<void> {
  const stage = process.argv[2] ?? "all";

  if (stage === "import") {
    const a = performance.now();
    await import(join(REPO, "apps/host-hub/src/worker/worker.ts"));
    process.stdout.write(`import worker module graph: ${((performance.now() - a) / 1000).toFixed(2)}s\n`);
    return;
  }

  const agentDir = mkdtempSync(join(tmpdir(), "probe-agent-"));
  const sessionsRoot = join(agentDir, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  cpSync(SESSION_SRC, join(sessionsRoot, SESSION_SRC.split("/").at(-1) as string), { recursive: true });

  const { spawn } = await import("node:child_process");

  const a = performance.now();
  child = spawn(EXEC.command, EXEC.args, {
    env: {
      ...process.env,
      HUB_AGENT_DIR: agentDir,
      HUB_SESSIONS_ROOT: sessionsRoot,
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (c: Buffer) => process.stderr.write(`[worker] ${c}`));
  child.stdout.on("data", (c: Buffer) => {
    buffer = Buffer.concat([buffer, c]);
    for (;;) {
      const nl = buffer.indexOf(10);
      if (nl < 0) break;
      const line = buffer.subarray(0, nl).toString("utf8");
      buffer = buffer.subarray(nl + 1);
      parseFrame(line);
    }
  });
  for (;;) {
    if (helloOk) break;
    await Bun.sleep(5);
  }
  mark(`spawn+hello (${((a - performance.now()) * -1 / 1000).toFixed(2)}s wall)`);

  const call = (id: string, frame: Record<string, unknown>, label: string) =>
    new Promise<void>((resolve) => {
      const began = performance.now();
      pending.set(id, {
        resolve: (v) => {
          const dt = ((performance.now() - began) / 1000).toFixed(2);
          const err = v.error !== undefined ? ` ERROR=${JSON.stringify(v.error).slice(0, 120)}` : "";
          process.stdout.write(`${label.padEnd(58)} ${dt}s${err}\n`);
          resolve();
        },
      });
      void child.stdin.write(lineOf({ id, ...frame }));
    });

  const sessionDirName = SESSION_SRC.split("/").at(-1) as string;
  mark("spawning worker process");
  await call("p1", { type: "thread/start", cwd: REPO, trusted: true }, "thread/start (fresh session, full assembly)");
  try {
    const lockPid = Number(await Bun.file(join(sessionsRoot, sessionDirName, "lock")).text()).valueOf();
    if (Number.isInteger(lockPid) && lockPid !== process.pid) {
      try { process.kill(lockPid, "SIGKILL"); } catch { }
    }
  } catch { }
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  mark("killed worker 1 (simulates stopped session)");

  const b = performance.now();
  child = spawn(EXEC.command, EXEC.args, {
    env: {
      ...process.env,
      HUB_AGENT_DIR: agentDir,
      HUB_SESSIONS_ROOT: sessionsRoot,
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (c: Buffer) => process.stderr.write(`[worker] ${c}`));
  child.stdout.on("data", (c: Buffer) => {
    buffer = Buffer.concat([buffer, c]);
    for (;;) {
      const nl = buffer.indexOf(10);
      if (nl < 0) break;
      const line = buffer.subarray(0, nl).toString("utf8");
      buffer = buffer.subarray(nl + 1);
      parseFrame(line);
    }
  });
  for (;;) {
    if (helloOk) break;
    await Bun.sleep(5);
  }
  mark(`worker 2 spawn+hello (${((b - performance.now()) * -1 / 1000).toFixed(2)}s wall)`);

  await call("p4", { type: "thread/resume", sessionPath: join(sessionsRoot, sessionDirName, "events.jsonl"), trusted: true, cwd: REPO }, "thread/resume (spawn new worker + reassemble)");

  const direct = performance.now();
  const { createArchiveReader } = await import(join(REPO, "packages/session-persistence-jsonl/src/archive.ts"));
  const arch = createArchiveReader(sessionsRoot);
  const read = await arch.read(SESSION_SRC.split("/").at(-1) as string);
  process.stdout.write(`${"archive.read alone (in-proc baseline)".padEnd(58)} ${((performance.now() - direct) / 1000).toFixed(2)}s ok=${String(read.ok)}\n`);

  if (!existsSync(join(sessionsRoot, SESSION_SRC.split("/").at(-1) as string, "events.jsonl"))) {
    process.stdout.write("session copy missing\n");
  }
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}

void main();
