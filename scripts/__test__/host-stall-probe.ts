import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const REPO = "/Users/wrr/work/x-harness";
const CLI = `${REPO}/apps/host-hub/src/host/cli.ts`;
const AGENT_DIR = "/Users/wrr/.pai/agent";
const SESSIONS_SRC = `${AGENT_DIR}/sessions`;
const SESSIONS = "/tmp/xh-sessions-clone";
const TARGET = process.env["PROBE_SESSION_ID"] ?? "20260926T191130-5w75d6";

if (!existsSync(`${SESSIONS}/${TARGET}/events.jsonl`)) {
  rmSync(SESSIONS, { recursive: true, force: true });
  await Bun.$`cp -Rc ${SESSIONS_SRC} ${SESSIONS}`.quiet();
}

const pending = new Map<string, (v: { ms: number; ok: boolean; error?: unknown }) => void>();
let buffer = "";

const child = spawn(process.execPath, [CLI], {
  env: { ...process.env, HUB_AGENT_DIR: AGENT_DIR, HUB_SESSIONS_ROOT: SESSIONS },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (c: Buffer) => process.stderr.write(`[hub] ${c.toString().slice(0, 200)}`));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let frame: { type?: string; id?: string; success?: boolean; error?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "response" && frame.id !== undefined) {
      const resolve = pending.get(frame.id);
      if (resolve === undefined) continue;
      pending.delete(frame.id);
      resolve({ ms: 0, ok: frame.success === true, error: frame.error });
    }
  }
});

function call(id: string, frame: Record<string, unknown>): Promise<{ ms: number; ok: boolean; error?: unknown }> {
  const began = performance.now();
  return new Promise((resolve) => {
    pending.set(id, (v) => resolve({ ...v, ms: performance.now() - began }));
    child.stdin.write(`${JSON.stringify({ id, ...frame })}\n`);
  });
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    child.stdin.write(`${JSON.stringify({ id: `hb${i}`, type: "get_host_info" })}\n`);
    const began = performance.now();
    const r = await Promise.race([call(`hb${i}`, {}), Bun.sleep(3000).then(() => undefined)]);
    if (r !== undefined && performance.now() - began < 2900) return;
  }
  throw new Error("host not ready");
}

function report(label: string, r: { ms: number; ok: boolean; error?: unknown }): void {
  process.stdout.write(`${label.padEnd(46)} ${r.ms.toFixed(0).padStart(6)}ms ok=${r.ok} ${r.error !== undefined ? JSON.stringify(r.error).slice(0, 90) : ""}\n`);
}

await waitReady();
process.stdout.write("host ready\n\n");

report("A list_saved alone", await call("a1", { type: "thread/list_saved" }));
report("B list_saved alone (warm)", await call("a2", { type: "thread/list_saved" }));

const solo = call("b1", {
  type: "thread/resume",
  sessionPath: `${SESSIONS}/${TARGET}/events.jsonl`,
  trusted: true,
  cwd: REPO,
});
report("C resume alone (spawns worker)", await solo);

const concurrent = call("c1", {
  type: "thread/resume",
  sessionPath: `${SESSIONS}/${TARGET}/events.jsonl`,
  trusted: true,
  cwd: REPO,
});
const listStorm = call("c2", { type: "thread/list_saved" });
report("D list_saved during resume", await listStorm);
report("C resume while list_saved in flight", await concurrent);

const stateStorm = Promise.all([
  call("d1", { type: "get_state", threadId: TARGET }),
  call("d2", { type: "get_state", threadId: TARGET }),
  call("d3", { type: "get_entries", threadId: TARGET, limit: 50 }),
  call("d4", { type: "thread/list_saved" }),
]);
const duringStorm = call("d5", {
  type: "thread/resume",
  sessionPath: `${SESSIONS}/${TARGET}/events.jsonl`,
  trusted: true,
  cwd: REPO,
});
await stateStorm;
report("E resume while parked reads + list in flight", await duringStorm);

child.kill("SIGTERM");
setTimeout(() => process.exit(0), 400);
