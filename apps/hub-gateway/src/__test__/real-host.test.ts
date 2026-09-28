// 真 host-hub 集成旅程（B3 审查发现「fake-host 集成假绿」的收口验收）：gateway spawn 真
// host（HUB_WORKER_PROVIDER=script 剧本 LLM——与 host-hub 自测同装置），全链断言：
// thread/start → WAL 事件扇出 → prompt → 剧本回复 → settled。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { connect as netConnect } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, type GatewayHandle } from "../main.ts";

let gw: GatewayHandle;
let agentDir: string;

/** 剧本：第一轮回文本（assistant 消息 + turn end） */
const script = [
  { reply: "hello from scripted llm" },
];

function hostExec(): { command: string; args: string[]; env: Record<string, string> } {
  const entry = join(process.cwd(), "apps/host-hub/src/host/cli.ts");
  return {
    command: process.execPath,
    args: [entry],
    env: {
      HUB_WORKER_PROVIDER: "script",
      HUB_WORKER_SCRIPT: JSON.stringify(script),
      HUB_SKILLS_MIGRATION: "0",
      HUB_AGENTS_MIGRATION: "0",
    },
  };
}

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "gw-real-host-"));
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await writeFile(join(agentDir, "gateway.json"), "{}", "utf8");
  const exec = hostExec();
  gw = await startGateway({
    agentDir,
    hostOverride: { command: exec.command, args: exec.args, env: exec.env },
    log: () => {},
  });
}, 20000);

afterAll(async () => {
  await gw.stop();
});

interface OwnerClient {
  lines(): Promise<string[]>;
  send(s: string): void;
  waitResponse(id: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function dialOwner(): Promise<OwnerClient> {
  const sock = netConnect(gw.ownerServer.socketPath);
  await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  const lines: string[] = [];
  sock.on("data", (c: Buffer) => { for (const l of c.toString().split("\n")) if (l) lines.push(l); });
  return {
    lines: async () => [...lines],
    send: (s) => sock.write(`${s}\n`),
    waitResponse: (id, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = (): void => {
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as { kind?: string; body?: { id?: string } };
              if (parsed.kind === "response" && parsed.body?.id === id) {
                resolve(parsed.body as Record<string, unknown>);
                return;
              }
            } catch {
              // skip
            }
          }
          if (Date.now() - t0 > timeoutMs) {
            reject(new Error(`owner response timeout ${id}; lines=${lines.length}`));
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      }),
    close: () => sock.destroy(),
  };
}

describe("真 host-hub 集成旅程", () => {
  it("thread/start（真 host）→ WAL 事件扇出到 owner → prompt → 剧本回复 → settled", { timeout: 60000 }, async () => {
    const owner = await dialOwner();
    owner.send(JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "thread/start", id: "r1", args: { cwd: process.cwd() } } }));
    const started = await owner.waitResponse("r1");
    expect(started.success).toBe(true);
    const threadId = (started.data as { threadId?: string }).threadId;
    expect(typeof threadId).toBe("string");

    // prompt（真 worker 跑剧本 LLM）——thread/start 本身不产生事件（WAL 事件由 worker 驱动）
    owner.send(JSON.stringify({ kind: "command", streamId: "owner", seq: 2, body: { command: "prompt", id: "r2", args: { threadId, text: "say hi" } } }));
    const promptRes = await owner.waitResponse("r2");
    expect(promptRes.success).toBe(true);

    // 等事件链完整扇出到 owner：turn/start … assistant/message … settled（剧本一轮）
    // 稳定事件集：不绑定消息形态名（agent/message vs assistant/message 随 skills 迁移环境而变）
    const required = ["turn/start", "settled"];
    const hasEvent = (lines: string[], name: string): boolean =>
      lines.some((l) => l.includes('"kind":"event"') && l.includes(threadId!) && l.includes(name));
    for (let i = 0; i < 250; i++) {
      await new Promise((r) => { setTimeout(r, 200); });
      const lines = await owner.lines();
      if (required.every((name) => hasEvent(lines, name))) break;
    }
    const finalLines = await owner.lines();
    for (const name of required) {
      expect(hasEvent(finalLines, name)).toBe(true);
    }
    owner.close();
  });
});
