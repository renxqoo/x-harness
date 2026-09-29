import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const REPO = "/Users/wrr/work/x-harness";
const CLI = `${REPO}/apps/host-hub/src/host/cli.ts`;
const AGENT_DIR = "/Users/wrr/.pai/agent";
const SESSIONS = "/tmp/xh-sessions-clone";
const TARGET = process.env["PROBE_SESSION_ID"] ?? "20260926T191130-5w75d6";
const CWDS = ["/Users/wrr/work/x-harness", "/Users/wrr/work/agent-app", "/Users/wrr/work/ZCode", "/Users/wrr/work/html-ui"];

if (!existsSync(`${SESSIONS}/${TARGET}/events.jsonl`)) {
  rmSync(SESSIONS, { recursive: true, force: true });
  await Bun.$`cp -Rc ${AGENT_DIR}/sessions ${SESSIONS}`.quiet();
}

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
  process.stdout.write(`${label.padEnd(52)} ${r.ms.toFixed(0).padStart(6)}ms ok=${r.ok}\n`);
}

for (let i = 0; i < 200; i += 1) {
  const r = await Promise.race([call({ type: "get_host_info" }), Bun.sleep(2000).then(() => undefined)]);
  if (r !== undefined) break;
  await Bun.sleep(100);
}
process.stdout.write("host ready\n\n");

show("baseline get_host_info (idle host)", await call({ type: "get_host_info" }));

const probe = call({ type: "get_host_info" });
const list = call({ type: "thread/list_saved" });
show("thread/list_saved", await list);
show("get_host_info issued right after list_saved", await probe);

const probes: Promise<{ ms: number; ok: boolean }>[] = [];
const started = performance.now();
for (const cwd of CWDS) {
  probes.push(call({ type: "get_host_info" }));
  void call({ type: "thread/list_saved", cwd });
}
const interleaved = await Promise.all(probes);
process.stdout.write(`\nreconcile storm: ${CWDS.length} x list_saved(cwd) fired together\n`);
for (const [i, r] of interleaved.entries()) {
  process.stdout.write(`  get_host_info #${i + 1} latency                ${r.ms.toFixed(0).padStart(6)}ms\n`);
}
process.stdout.write(`  storm wall clock                          ${(performance.now() - started).toFixed(0).padStart(6)}ms\n`);

const resumeFrame = { type: "thread/resume", sessionPath: `${SESSIONS}/${TARGET}/events.jsonl`, trusted: true, cwd: REPO };
const first = call(resumeFrame);
await Bun.sleep(150);
const second = call(resumeFrame);
show("resume #1 (wins the slot)", await first);
show("resume #2 150ms later (collides)", await second);

child.kill("SIGTERM");
setTimeout(() => process.exit(0), 400);
