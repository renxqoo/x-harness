import { spawn } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";

const REPO = "/Users/wrr/work/x-harness";
const CLI = `${REPO}/apps/host-hub/src/host/cli.ts`;
const AGENT_DIR = "/Users/wrr/.pai/agent";
const SESSIONS = "/tmp/xh-sessions-clone";
const BIG = process.env["PROBE_SESSION_ID"] ?? "20260926T191130-5w75d6";

if (!existsSync(`${SESSIONS}/${BIG}/events.jsonl`)) {
  rmSync(SESSIONS, { recursive: true, force: true });
  await Bun.$`cp -Rc ${AGENT_DIR}/sessions ${SESSIONS}`.quiet();
}
const lock = `${SESSIONS}/${BIG}/lock`;
if (existsSync(lock)) unlinkSync(lock);

const pending = new Map<string, (v: { ok: boolean }) => void>();
let buffer = "";
const child = spawn(process.execPath, [CLI], {
  env: { ...process.env, HUB_AGENT_DIR: AGENT_DIR, HUB_SESSIONS_ROOT: SESSIONS },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let frame: { type?: string; id?: string; success?: boolean };
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "response" && frame.id !== undefined) {
      const resolve = pending.get(frame.id);
      if (resolve === undefined) continue;
      pending.delete(frame.id);
      resolve({ ok: frame.success === true });
    }
  }
});

let seq = 0;
function call(frame: Record<string, unknown>): Promise<{ ms: number; ok: boolean }> {
  const id = `q${(seq += 1)}`;
  const began = performance.now();
  return new Promise((resolve) => {
    pending.set(id, (v) => resolve({ ms: performance.now() - began, ok: v.ok }));
    child.stdin.write(`${JSON.stringify({ id, ...frame })}\n`);
  });
}
function show(label: string, r: { ms: number; ok: boolean }): void {
  process.stdout.write(`${label.padEnd(50)} ${r.ms.toFixed(0).padStart(6)}ms ok=${r.ok}\n`);
}

for (let i = 0; i < 200; i += 1) {
  const r = await Promise.race([call({ type: "get_host_info" }), Bun.sleep(2000).then(() => undefined)]);
  if (r !== undefined) break;
  await Bun.sleep(100);
}
process.stdout.write(`host ready  (session ${BIG})\n\n`);

show("thread/register (parks row; reads whole log)", await call({
  type: "thread/register",
  sessionPath: `${SESSIONS}/${BIG}/events.jsonl`,
  trusted: true,
}));

show("baseline get_host_info", await call({ type: "get_host_info" }));

const probe = call({ type: "get_host_info" });
const reads = [
  call({ type: "get_state", threadId: BIG }),
  call({ type: "get_entries", threadId: BIG, limit: 50 }),
  call({ type: "get_state", threadId: BIG }),
  call({ type: "get_entries", threadId: BIG, limit: 50 }),
];
const readResults = await Promise.all(reads);
show("get_host_info issued alongside parked reads", await probe);
for (const [i, r] of readResults.entries()) show(`  parked read #${i + 1}`, r);

child.kill("SIGTERM");
setTimeout(() => process.exit(0), 400);
