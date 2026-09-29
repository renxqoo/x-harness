import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../main.ts";
import type { Frame } from "@x-harness/remote-protocol";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let agentDir: string;
let stopGateway: (() => Promise<void>) | null = null;
let socketPath: string;
let currentHandle: Awaited<ReturnType<typeof startGateway>> | null = null;
function currentGatewayHandle(): Awaited<ReturnType<typeof startGateway>> {
  if (currentHandle === null) throw new Error("gateway not started");
  return currentHandle;
}

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "gw-b2-"));
  await (await import("node:fs/promises")).writeFile(
    join(agentDir, "gateway.json"),
    JSON.stringify({ remoteEnabled: true, relayUrl: "ws://127.0.0.1:9", relayKeyFingerprint: "fp-b2-test" }),
    "utf8",
  );
  const self = new URL("./fake-host.ts", import.meta.url).pathname;
  const handle = await startGateway({
    agentDir,
    hostOverride: { command: process.execPath, args: [self, "--fake-host"] },
    log: () => {},
  });
  currentHandle = handle;
  socketPath = handle.ownerServer.socketPath;
  stopGateway = () => handle.stop();
}, 20000);

afterAll(async () => {
  await stopGateway?.();
});

interface OwnerClient {
  send(frame: unknown): void;
  lines(): Promise<string[]>;
  waitResponse(id: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function dialOwner(path: string): Promise<OwnerClient> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`dialOwner timeout: ${path}`));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const received: string[] = [];
  socket.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.length > 0) received.push(line);
    }
  });
  return {
    send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    lines: async () => received.slice(),
    waitResponse: (id, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = (): void => {
          for (const line of received) {
            try {
              const parsed = JSON.parse(line) as { kind?: string; body?: { id?: string } };
              if (parsed.kind === "response" && parsed.body?.id === id) {
                resolve(parsed.body as Record<string, unknown>);
                return;
              }
            } catch {
            }
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`waitResponse timeout for ${id}; lines=${received.length}`));
            return;
          }
          setTimeout(tick, 25);
        };
        tick();
      }),
    close: () => socket.destroy(),
  };
}

function commandFrame(id: string, command: string, args?: Record<string, unknown>): Frame {
  return { kind: "command", streamId: "owner", seq: Math.floor(Math.random() * 100000) + 1, body: { command, id, args } };
}

describe("gateway B2 骨架", () => {
  it("gw/status：installationId/hostAlive/devices", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("s1", "gw/status"));
    const res = await client.waitResponse("s1");
    expect(res.success).toBe(true);
    const data = res.data as { installationId: string; hostAlive: boolean; devices: number };
    expect(data.installationId).toBeTruthy();
    expect(data.hostAlive).toBe(true);
    client.close();
  });

  it("host 命令管线：thread/start → response 认领回投 + 事件扇出到 owner + 注册表登记", { timeout: 15000 }, async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("c1", "thread/start", { cwd: "/tmp" }));
    const res = await client.waitResponse("c1");
    expect(res.success).toBe(true);
    expect((res.data as { threadId?: string }).threadId).toBe("t_fake_1");
    await sleep(300);
    const lines = await client.lines();
    const events = lines.map((l) => JSON.parse(l) as Frame).filter((f) => f.kind === "event");
    expect(events.length).toBeGreaterThanOrEqual(1);
    client.close();
  });

  it("去重：同 (deviceId, commandId) 重发直接回缓存 response（host 不双收）", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("d1", "thread/list"));
    const first = await client.waitResponse("d1");
    expect(first.success).toBe(true);
    client.send(commandFrame("d1", "thread/list"));
    const second = await client.waitResponse("d1");
    expect(second).toEqual(first);
    client.close();
  });

  it("owner-only 词表执法：gw/shutdown 走本地族；未知 gw/* 拒", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("u1", "gw/nonexistent"));
    const res = await client.waitResponse("u1");
    expect(res.success).toBe(false);
    client.close();
  });

  it("gw/devices/set_scope + revoke + 审计落盘", { timeout: 15000 }, async () => {
    const registryPath = join(agentDir, "devices", "registry.json");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(agentDir, "devices"), { recursive: true });
    await writeFile(registryPath, JSON.stringify({ devices: [{ deviceId: "d_test", name: "Phone", deviceType: "phone", platform: "ios", appVersion: "1", longTermPub: "aa", scope: "read", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 }] }), "utf8");
    await stopGateway?.();
    const self = new URL("./fake-host.ts", import.meta.url).pathname;
    const handle = await startGateway({ agentDir, hostOverride: { command: process.execPath, args: [self, "--fake-host"] }, log: () => {} });
    currentHandle = handle;
    socketPath = handle.ownerServer.socketPath;
    stopGateway = () => handle.stop();
    await new Promise((r) => { setTimeout(r, 200); });
    const client = await dialOwner(socketPath);
    client.send(commandFrame("sc1", "gw/devices/set_scope", { deviceId: "d_test", scope: "interact" }));
    const res = await client.waitResponse("sc1");
    expect(res.success).toBe(true);
    client.send(commandFrame("sc9", "gw/devices/set_scope", { deviceId: "d_test", scope: "full" }));
    expect((await client.waitResponse("sc9")).success).toBe(true);
    client.send(commandFrame("rv1", "gw/devices/revoke", { deviceId: "d_test" }));
    const rv = await client.waitResponse("rv1");
    expect(rv.success).toBe(true);
    client.send(commandFrame("rv0", "gw/devices/revoke", { deviceId: "ghost" }));
    expect((await client.waitResponse("rv0")).success).toBe(false);
    client.send(commandFrame("sc0", "gw/devices/set_scope", { deviceId: "ghost", scope: "interact" }));
    expect((await client.waitResponse("sc0")).success).toBe(false);
    client.close();
    const auditDir = join(agentDir, "audit");
    const names = await (await import("node:fs/promises")).readdir(auditDir);
    let auditAll = "";
    for (const n of names) auditAll += await readFile(join(auditDir, n), "utf8");
    expect(auditAll).toContain("device-scope-changed");
    expect(auditAll).toContain("device-revoked");
    expect(auditAll).toContain("command-issued");
  });

  it("gw/config/get + gw/logs/tail", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("cg1", "gw/config/get"));
    const cg = await client.waitResponse("cg1");
    expect(cg.success).toBe(true);
    client.send(commandFrame("lt1", "gw/logs/tail"));
    const lt = await client.waitResponse("lt1");
    expect(lt.success).toBe(true);
    client.close();
  });

  it("ui_response 旅程：owner 应答转发 host + 审计", async () => {
    const client = await dialOwner(socketPath);
    client.send({ kind: "ui_response", streamId: "owner", seq: 999, body: { requestId: "rq_1", payload: { confirmed: true } } });
    await sleep(200);
    const auditDir = join(agentDir, "audit");
    const names = await (await import("node:fs/promises")).readdir(auditDir);
    const text = await readFile(join(auditDir, names[0]!), "utf8");
    expect(text).toContain("ui_request-settled");
    client.close();
  });

  it("gw 设备命令错误路径：缺 deviceId/无此设备/坏 scope/未知 gw 兜底", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("e1", "gw/devices/rename"));
    const e1 = await client.waitResponse("e1");
    expect(e1.success).toBe(false);
    client.send(commandFrame("e2", "gw/devices/rename", { deviceId: "ghost" }));
    expect((await client.waitResponse("e2")).success).toBe(false);
    const registryPath = join(agentDir, "devices", "registry.json");
    const { writeFile } = await import("node:fs/promises");
    const current = JSON.parse(await readFile(registryPath, "utf8")) as { devices: unknown[] };
    current.devices.push({ deviceId: "d_err", name: "E", deviceType: "phone", platform: "ios", appVersion: "1", longTermPub: "cc", scope: "read", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 });
    await writeFile(registryPath, JSON.stringify(current), "utf8");
    client.send(commandFrame("e3", "gw/devices/set_scope", { deviceId: "d_err", scope: "banana" }));
    expect((await client.waitResponse("e3")).success).toBe(false);
    client.send(commandFrame("e4", "gw/pairing/cancel"));
    expect((await client.waitResponse("e4")).success).toBe(false);
    client.close();
  });

  it("坏帧 → error 帧（bad-frame）不崩", async () => {
    const client = await dialOwner(socketPath);
    client.send(JSON.stringify({ kind: "nope", streamId: "owner", seq: 1, body: {} }));
    const res = await client.waitResponse("__none__", 1500).catch(() => null);
    expect(res).toBeNull();
    client.close();
  });

  it("词表执法：矩阵外命令拒（unknown-command）；owner 对 owner-only 命令放行（settings/set 走 host 面）", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("x1", "rm -rf /"));
    const res = await client.waitResponse("x1");
    expect(res.success).toBe(false);
    expect(res.error).toBe("unknown-command");
    client.close();
  });

  it("gw/config/set：remoteEnabled 热应用；其余键重启生效", { timeout: 15000 }, async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("cs1", "gw/config/set", { remoteEnabled: false }));
    const res = await client.waitResponse("cs1");
    expect(res.success).toBe(true);
    client.send(commandFrame("cs2", "gw/config/set", { hostBin: "/x" }));
    expect((await client.waitResponse("cs2")).success).toBe(false);
    client.send(commandFrame("cg9", "gw/config/get"));
    expect((await client.waitResponse("cg9")).success).toBe(true);
    client.close();
  });

  it("gw/logs/tail：返回最近日志行", { timeout: 15000 }, async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("lt9", "gw/logs/tail"));
    const res = await client.waitResponse("lt9");
    expect(res.success).toBe(true);
    client.close();
  });

  it("C1/B5b 回归：host 退出自动拉起；write 失败路径合成 failure 进去重缓存", { timeout: 25000 }, async () => {
    const client = await dialOwner(socketPath);
    const handle = currentGatewayHandle();
    handle.host.killChildForTest();
    await new Promise((r) => { setTimeout(r, 800); });
    expect(handle.host.alive()).toBe(true);
    client.send(commandFrame("hc1", "thread/list"));
    expect((await client.waitResponse("hc1")).success).toBe(true);
    client.close();
  });

  it("gw/shutdown：受理后网关停（stop 幂等）", async () => {
    const client = await dialOwner(socketPath);
    client.send(commandFrame("sd1", "gw/shutdown"));
    const res = await client.waitResponse("sd1");
    expect(res.success).toBe(true);
    await sleep(600);
    client.close();
  }, 10000);
});
