import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = "/Users/wrr/work/x-harness";
const CLI = join(REPO, "apps/host-hub/src/host/cli.ts");
const SESSION_SRC = process.env["PROBE_SESSION"] ?? "/Users/wrr/.pai/agent/sessions/20260926T191130-5w75d6";
const MARKER = `PROBE-MSG-${Date.now()}`;

interface Frame {
  time: number;
  raw: string;
  parsed: Record<string, unknown>;
}

let t0 = performance.now();
const now = (): number => performance.now() - t0;
const ms = (v: number): string => (v >= 100 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
const log: string[] = [];

function record(line: string): void {
  const text = `[${ms(now())}] ${line}`;
  log.push(text);
  process.stdout.write(`${text}\n`);
}

interface Host {
  child: ChildProcess;
  send: (frame: Record<string, unknown>) => void;
  frames: Frame[];
  call: (frame: Record<string, unknown>, label: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitEvent: (name: string, timeoutMs?: number) => Promise<Frame>;
}

function bootHost(agentDir: string, label: string): Promise<Host> {
  const frames: Frame[] = [];
  const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>();
  const eventWaiters: Array<{ name: string; resolve: (f: Frame) => void }> = [];
  let buffer = Buffer.alloc(0);
  const bootAt = performance.now();
  t0 = bootAt;
  record(`--- ${label}: spawn hub host`);

  const child = spawn(process.execPath, [CLI], {
    env: {
      ...process.env,
      HUB_AGENT_DIR: agentDir,
      HUB_SESSIONS_ROOT: join(agentDir, "sessions"),
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "ok" }]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (c: Buffer) => {
    const text = c.toString().trim();
    if (text.length > 0) log.push(`[host-stderr] ${text}`);
  });

  const host: Host = {
    child,
    frames,
    send: (frame) => {
      void child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    async call(frame: Record<string, unknown>, labelCall?: string, timeoutMs = 30_000) {
      const id = frame["id"] === undefined ? `c${pending.size + 1}` : String(frame["id"]);
      const began = performance.now();
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${labelCall ?? id} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        host.send({ id, ...frame });
      });
      if (labelCall !== undefined) record(`${labelCall.padEnd(46)} ${ms(performance.now() - began)}`);
      return result;
    },
    async waitEvent(name, timeoutMs = 30_000) {
      const existing = frames.find((f) => f.parsed["type"] === "event" && f.parsed["name"] === name && (name !== "turn/start" || Boolean(f.parsed["threadId"])));
      if (existing !== undefined) return existing;
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`event ${name} timeout`)), timeoutMs);
        eventWaiters.push({
          name,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const nl = buffer.indexOf(10);
      if (nl < 0) break;
      const line = buffer.subarray(0, nl).toString("utf8");
      buffer = buffer.subarray(nl + 1);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const frame: Frame = { time: performance.now(), raw: line, parsed };
      frames.push(frame);
      if (parsed["type"] === "heartbeat" && (now() < 60_000) === false) continue;
      if (parsed["type"] === "heartbeat") {
        const readyMs = frame.time - bootAt;
        if (readyMs < 30_000 && !log.some((l) => l.includes("host ready"))) record(`host ready (first heartbeat)`.padEnd(46) + ` ${ms(readyMs)}`);
        continue;
      }
      if (parsed["type"] === "event") {
        const name = String(parsed["name"]);
        for (const [index, waiter] of eventWaiters.entries()) {
          if (waiter.name === name) {
            eventWaiters.splice(index, 1);
            waiter.resolve(frame);
            break;
          }
        }
      }
      const id = parsed["id"] === undefined || parsed["id"] === null ? undefined : String(parsed["id"]);
      if (id !== undefined && pending.has(id)) {
        const entry = pending.get(id) as { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> };
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(parsed);
      }
    }
  });

  return new Promise<Host>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (frames.length > 0) resolve(host);
      else reject(new Error("host boot timeout"));
    }, 5_000);
    child.once("exit", (code) => reject(new Error(`host exited early: ${code}`)));
  });
}

function killHost(host: Host): Promise<void> {
  return new Promise((resolve) => {
    host.child.once("exit", () => resolve());
    host.child.kill("SIGTERM");
    setTimeout(() => host.child.kill("SIGKILL"), 3_000).unref?.();
  });
}

async function waitForTurnEnd(host: Host, timeoutMs = 8_000): Promise<void> {
  const began = performance.now();
  for (;;) {
    const settled = host.frames.find((f) => f.time > began && (f.parsed["name"] === "turn/end" || f.parsed["name"] === "settled"));
    if (settled !== undefined) return;
    await Bun.sleep(20);
    if (performance.now() - began > timeoutMs) throw new Error("turn end timeout");
  }
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
  return "";
}

async function measurePromptToVisible(host: Host, threadId: string): Promise<{ ack: number; turnStart: number; userFrame: number; entries: number; ackData: unknown }> {
  const promptAt = performance.now();
  const ackPromise = host.call({ type: "prompt", threadId, message: MARKER }, "prompt (ack)");
  const turnStartAt = await host
    .waitEvent("turn/start")
    .then((f) => f.time - promptAt)
    .catch(() => -1);
  const userFrameAt = await host
    .waitEvent("user/message")
    .then((f) => f.time - promptAt)
    .catch(() => -1);
  const ack = await ackPromise.then((r) => performance.now() - promptAt);
  const ackData = ack.data;

  let entries = -1;
  const entriesBegan = performance.now();
  for (;;) {
    const result = await host.call({ type: "get_entries", threadId, view: "journal", limit: 5000 });
    const data = result.data as { entries?: Array<{ event?: { type?: string; data?: { content?: unknown } } }>; leafSeq?: number } | undefined;
    const found = data?.entries?.some((e) => e.event?.type === "user/message" && flattenText(e.event.content).includes(MARKER)) === true;
    if (found) {
      entries = performance.now() - promptAt;
      record(`${"消息在对话列表可见 (对账命中)".padEnd(46)} ${ms(entries)}`);
      break;
    }
    if (performance.now() - entriesBegan > 15_000) {
      record("消息可见: TIMEOUT (15s 内对账未命中)");
      break;
    }
    await Bun.sleep(25);
  }
  return { ack, turnStart: turnStartAt, userFrame: userFrameAt, entries, ackData };
}

async function main(): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "send-probe-"));
  const sessionsRoot = join(agentDir, "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const sessionName = SESSION_SRC.split("/").at(-1) as string;
  cpSync(SESSION_SRC, join(sessionsRoot, sessionName), { recursive: true });
  const sessionPath = join(sessionsRoot, sessionName, "events.jsonl");
  record(`fixture: ${sessionName} 已复制到临时 agentDir`);

  const host1 = await bootHost(agentDir, "阶段A: 首次启动 (等价 app 冷启动)");
  record(`--- 阶段A: thread/start 全新会话 (含插件组装)`);
  const started = await host1.call({ type: "thread/start", cwd: REPO, trusted: true }, "thread/start");
  const threadId1 = String((started.data as { threadId?: string })?.threadId ?? "");
  await waitForTurnEnd(host1).catch((e) => record(`turnEnd wait skipped: ${e.message}`));
  record(`--- 阶段A: 温热会话上发消息 (对照: 不重启直接发)`);
  const warm = await measurePromptToVisible(host1, threadId1);
  await waitForTurnEnd(host1).catch((e) => record(`turnEnd wait skipped: ${e.message}`));
  await killHost(host1);
  record(`--- host #1 已退出 (等价 app 退出; prompt cache 随进程存活, hub 重启即全冷)`);

  const host2 = await bootHost(agentDir, "阶段B: 重启 host (等价 app 重启)");
  record(`--- 阶段B: parked 会话 resume (等价重启后发消息时 resolveTarget 的懒唤醒)`);
  const resumedAt = performance.now();
  const resumed = await host2.call({ type: "thread/resume", sessionPath, trusted: true, cwd: REPO });
  const resumeMs = performance.now() - resumedAt;
  const threadId2 = String((resumed.data as { threadId?: string })?.threadId ?? "");
  record(`thread/resume (懒唤醒, 13MB WAL 读+组装)`.padEnd(46) + ` ${ms(resumeMs)}`);

  const state2 = await host2.call({ type: "get_state", threadId: threadId2 }, "get_state (确认表项)");

  record(`--- 阶段B: resume 后发消息 (用户体感: 回车 → 气泡上屏)`);
  const cold = await measurePromptToVisible(host2, threadId2);
  await waitForTurnEnd(host2).catch((e) => record(`turnEnd wait skipped: ${e.message}`));

  record("");
  record("== 汇总 (回车 → 气泡可见) ==");
  record(`温热会话 (不重启):    ack ${ms(warm.ack)} | turn/start ${ms(warm.turnStart)} | user/message帧 ${ms(warm.userFrame)} | 可见 ${ms(warm.entries)}`);
  record(`重启后冷路径:         ack ${ms(cold.ack)} | turn/start ${ms(cold.turnStart)} | user/message帧 ${ms(cold.userFrame)} | 可见 ${ms(cold.entries)}`);
  record(`其中 resume(懒唤醒)占 ${ms(resumeMs)}, 位于 prompt 之前, 渲染层 await 它`);
  record(`=> 事件帧先于对账到达的差值 = 纯 app 层(事件映射+对账)引入的额外延迟: 温热 ${ms(warm.entries - warm.userFrame)} / 冷 ${ms(cold.entries - cold.userFrame)}`);

  await killHost(host2);
  writeFileSync(join(REPO, "scripts/__test__/send-latency-probe.log"), log.join("\n"));
  record(`full log: scripts/__test__/send-latency-probe.log`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`probe failed: ${String(error)}\n`);
  writeFileSync(join(REPO, "scripts/__test__/send-latency-probe.log"), log.join("\n"));
  process.exit(1);
});
