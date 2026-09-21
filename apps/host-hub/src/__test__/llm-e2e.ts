// real LLM 门（opt-in 不进默认门禁——IMPLEMENTATION §5 层 5）：真 host 进程 + 真
// worker + 真 compat adapter 拨号（GLM）。旅程：heartbeat → host_info → start(modelId)
// → prompt settled → WAL assistant 消息 → 标题 → fork 分支对话 → 多会话并发（5
// 线程隔离 + 批量收编）→ retire→parked 直读 → wake → EOF exit 0。
// 运行：bun run e2e:llm（GLM_API_KEY 缺省回落 packages/e2e/.env 同源）
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

interface Frame {
  type: string;
  [key: string]: unknown;
}

async function loadEnv(): Promise<void> {
  if (process.env["GLM_API_KEY"] !== undefined) return;
  const dotenv = join(import.meta.dirname, "../../../../packages/e2e/.env");
  if (!existsSync(dotenv)) return;
  const { readFileSync } = await import("node:fs");
  for (const line of (readFileSync(dotenv, "utf8") as string).split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match !== null && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

async function main(): Promise<void> {
  await loadEnv();
  const apiKey = process.env["GLM_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    console.error("llm-e2e: GLM_API_KEY missing (packages/e2e/.env fallback absent) — SKIP");
    return;
  }
  const model = process.env["GLM_MODEL"] ?? "glm-4.6";
  const baseUrl = process.env["GLM_BASE_URL"] ?? "https://open.bigmodel.cn/api/anthropic";
  const agentDir = await mkdtemp(join(tmpdir(), "hub-llm-"));
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  // 目录走 models.json custom 条目面（生产接入形态）
  await writeFile(
    join(agentDir, "providers.json"),
    JSON.stringify({
      providers: [{ name: "glm", protocol: "anthropic", baseUrl, apiKey, models: [model], contextWindow: 200_000 }],
      default: { provider: "glm", model },
    }),
    "utf8",
  );
  const entry = join(import.meta.dirname, "../host/cli.ts");
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, HUB_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Frame[] = [];
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim() === "") continue;
      lines.push(JSON.parse(raw) as Frame);
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[llm-host] ${String(chunk)}`));
  const dump = (label: string): void => {
    // 失败取证：按线程汇总帧名计数（定位停层——turn 未起/流中断/不收敛）
    const byThread = new Map<string, Map<string, number>>();
    for (const frame of lines) {
      if (frame.type !== "event") continue;
      const tid = String(frame.threadId ?? "");
      const counts = byThread.get(tid) ?? new Map<string, number>();
      counts.set(String(frame.name), (counts.get(String(frame.name)) ?? 0) + 1);
      byThread.set(tid, counts);
    }
    console.error(`llm-e2e frames@timeout(${label}): responses=${lines.filter((f) => f.type === "response").length}`);
    for (const [tid, counts] of byThread) console.error(`  ${tid}: ${JSON.stringify([...counts.entries()])}`);
  };
  const wait = async (pred: (frame: Frame) => boolean, label: string, timeoutMs = 120_000): Promise<Frame> => {
    const started = Date.now();
    for (;;) {
      for (const frame of lines) {
        if (pred(frame)) return frame;
      }
      if (Date.now() - started > timeoutMs) {
        dump(label);
        throw new Error(`llm-e2e wait timeout: ${label}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 50);
      });
    }
  };
  const response = (id: string): Promise<Frame> => wait((frame) => frame.type === "response" && frame.id === id, `response ${id}`);
  const send = (cmd: unknown): void => {
    proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  const step = (name: string): void => {
    console.log(`llm-e2e: ${name}`);
  };

  await wait((frame) => frame.type === "heartbeat", "heartbeat");
  step("heartbeat ✓");
  send({ type: "get_host_info", id: "h1" });
  const info = await response("h1");
  if (!info.success) throw new Error("host_info failed");
  step("host_info ✓");

  send({ type: "thread/start", id: "s1", cwd: agentDir, modelId: model, provider: "glm" });
  const started = await response("s1");
  if (!started.success) throw new Error(`thread/start failed: ${String(started.error)}`);
  const threadId = (started.data as { threadId: string }).threadId;
  step(`thread/start ✓ (${threadId})`);

  send({ type: "prompt", id: "p1", threadId, message: "Reply with exactly: hub-llm-ok" });
  await response("p1");
  await wait((frame) => frame.type === "event" && frame.name === "settled" && (frame.payload as { sendId?: string }).sendId === "p1", "settled p1", 180_000);
  step("prompt settled ✓");

  const wal = await readFile(join(agentDir, "sessions", threadId, "events.jsonl"), "utf8");
  if (!wal.includes("hub-llm-ok")) throw new Error("WAL missing assistant reply");
  step("WAL assistant ✓");

  send({ type: "set_session_name", id: "n1", threadId, name: "llm journey" });
  await response("n1");
  send({ type: "fork", id: "f1", threadId, seq: 1, position: "at" });
  const forked = await response("f1");
  if (!forked.success) throw new Error("fork failed");
  const forkId = (forked.data as { threadId: string }).threadId;
  send({ type: "prompt", id: "p2", threadId: forkId, message: "Reply with exactly: fork-ok" });
  await response("p2");
  await wait((frame) => frame.type === "event" && frame.name === "settled" && (frame.payload as { sendId?: string }).sendId === "p2", "settled p2", 180_000);
  step("fork branch dialog ✓");

  const concurrent: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    send({ type: "thread/start", id: `sc-${i}`, cwd: agentDir, modelId: model, provider: "glm" });
    const res = await response(`sc-${i}`);
    if (!res.success) throw new Error(`concurrent start ${i} failed`);
    concurrent.push((res.data as { threadId: string }).threadId);
  }
  for (const [i, tid] of [threadId, ...concurrent].entries()) {
    void i;
    void tid;
  }
  send({ type: "prompt", id: "cc-0", threadId: concurrent[0] as string, message: "Reply: c0" });
  await response("cc-0");
  await wait((frame) => frame.type === "event" && frame.name === "settled" && (frame.payload as { sendId?: string }).sendId === "cc-0", "settled cc-0", 180_000);
  for (const [i, tid] of concurrent.entries()) {
    send({ type: "thread/retire", id: `cr-${i}`, threadId: tid });
    await response(`cr-${i}`);
  }
  step("concurrent sessions + batch retire ✓");

  send({ type: "thread/retire", id: "rt1", threadId: forkId });
  await response("rt1");
  await wait((frame) => frame.type === "thread_parked" && frame.threadId === forkId, "parked");
  send({ type: "get_state", id: "gs1", threadId: forkId });
  const parkedState = await response("gs1");
  if (!parkedState.success) throw new Error("parked get_state failed");
  send({ type: "prompt", id: "p3", threadId: forkId, message: "Reply: wake-ok" });
  await response("p3");
  await wait((frame) => frame.type === "event" && frame.name === "settled" && (frame.payload as { sendId?: string }).sendId === "p3", "settled p3", 180_000);
  step("retire→parked read→wake ✓");

  proc.stdin.end();
  const code = await new Promise<number>((resolve) => {
    proc.on("exit", (c) => {
      resolve(c ?? -1);
    });
  });
  if (code !== 0) throw new Error(`exit code ${code}`);
  step("EOF exit 0 ✓");
  console.log("llm-e2e: PASS");
}

main().catch((error) => {
  console.error(`llm-e2e: FAIL — ${String(error)}`);
  process.exit(1);
});
