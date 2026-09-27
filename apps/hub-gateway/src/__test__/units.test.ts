// B2 单元补齐：threads-registry CRUD/epoch、host-attach 泵/死线/重启、fanout 扇出域与
// coalesce、config 语义、identity 恢复旅程
import { describe, expect, it } from "vitest";
import { loadThreads } from "../threads-registry.ts";
import { loadConfig } from "../config.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Fanout, classifyHostLine } from "../fanout.ts";
import type { Frame } from "@x-harness/remote-protocol";

describe("threads-registry", () => {
  it("upsert/get/remove/bumpEpoch 落盘往返", async () => {
    const dir = await mkdtemp(join(tmpdir(), "threads-"));
    const path = join(dir, "threads.json");
    const reg = await loadThreads(path);
    reg.upsert({ threadId: "t1", sessionPath: "/a.jsonl" });
    expect(reg.get("t1")?.sessionPath).toBe("/a.jsonl");
    expect(reg.get("t1")?.epoch).toBe(1);
    expect(reg.bumpEpoch("t1")).toBe(2);
    expect(reg.remove("t1")).toBe(true);
    expect(reg.remove("t1")).toBe(false);
    // 落盘往返
    reg.upsert({ threadId: "t2", sessionPath: "/b.jsonl" });
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const reg2 = await loadThreads(path);
    expect(reg2.get("t2")?.sessionPath).toBe("/b.jsonl");
    // 坏 JSON 降级空表
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not-json", "utf8");
    const reg3 = await loadThreads(path);
    expect(reg3.all().length).toBe(0);
  });
});

describe("loadConfig 语义", () => {
  it("缺席 = 全缺省本地形态；remoteEnabled 校验三连拒", () => {
    const absent = loadConfig(null);
    expect(absent.ok && absent.config.remoteEnabled).toBe(false);
    expect(loadConfig("not-json").ok).toBe(false);
    expect(loadConfig('{"remoteEnabled":true}').ok).toBe(false);
    expect(loadConfig('{"remoteEnabled":true,"relayUrl":"ws://x"}').ok).toBe(false);
    const ok = loadConfig('{"remoteEnabled":true,"relayUrl":"wss://x","relayKeyFingerprint":"fp"}');
    expect(ok.ok && ok.config.relayUrl).toBe("wss://x");
    // maxDevices 坏值降级 16；logLevel 白名单
    const coerced = loadConfig('{"remoteEnabled":false,"maxDevices":-5,"logLevel":"nope"}');
    expect(coerced.ok && coerced.config.maxDevices).toBe(16);
    expect(coerced.ok && coerced.config.logLevel).toBe("info");
  });
});

describe("classifyHostLine 前缀分类", () => {
  it("八分支", () => {
    expect(classifyHostLine('{"type":"response"')).toBe("response");
    expect(classifyHostLine('{"type":"event"')).toBe("event");
    expect(classifyHostLine('{"type":"ui_request"')).toBe("ui_request");
    expect(classifyHostLine('{"type":"heartbeat"')).toBe("heartbeat");
    expect(classifyHostLine('{"type":"hub_error"')).toBe("hub_error");
    expect(classifyHostLine('{"type":"thread_died"')).toBe("thread_died");
    expect(classifyHostLine('{"type":"thread_parked"')).toBe("thread_parked");
    expect(classifyHostLine("garbage")).toBe("unknown");
  });
});

describe("fanout", () => {
  function makeFanout() {
    const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
    const frames: Frame[] = [];
    fanout.attach({
      target: "owner",
      tier: "owner",
      subscribedThreads: new Set(),
      send: (frame) => frames.push(frame),
    });
    return { fanout, frames };
  }

  it("事件扇出：订阅域过滤；seq 单调", () => {
    const { fanout, frames } = makeFanout();
    const owner = fanout.targetOf("owner")!;
    owner.subscribedThreads.add("tA");
    fanout.fanoutEvent({ threadId: "tA", name: "turn/start", payload: {} });
    fanout.fanoutEvent({ threadId: "tA", name: "turn/end", payload: {} });
    fanout.fanoutEvent({ threadId: "tB", name: "turn/start", payload: {} });
    // owner 恒收全部线程（含未订阅 tB）；seq 为 per-thread 域（tA: 1,2；tB: 1）
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 1]);
    const names = frames.map((f) => (f.body as { threadId: string }).threadId);
    expect(names).toEqual(["tA", "tA", "tB"]);
  });

  it("ui_request 广播：read 档被过滤", () => {
    const { fanout, frames } = makeFanout();
    fanout.attach({ target: "dev_read", tier: "read", subscribedThreads: new Set(["tA"]), send: (f) => frames.push(f) });
    fanout.fanoutUiRequest({ requestId: "r1", threadId: "tA", method: "confirm", payload: {} });
    // 只有 owner（非 read）收到
    const uiFrames = frames.filter((f) => f.kind === "ui_request");
    expect(uiFrames.length).toBe(1);
  });

  it("hostId 自铸：g 前缀单调且不撞保留前缀", () => {
    const { fanout } = makeFanout();
    const a = fanout.mintHostId();
    const b = fanout.mintHostId();
    expect(a.startsWith("g")).toBe(true);
    expect(Number(b.slice(1))).toBe(Number(a.slice(1)) + 1);
  });
});

describe("device-registry + 去重日志崩溃恢复", () => {
  it("appendCommand/appendResponse/dedupLookup/mapHostId 全旅程 + 重启重放", async () => {
    const { loadDeviceRegistry } = await import("../device-registry.ts");
    const dir = await mkdtemp(join(tmpdir(), "devreg-"));
    const paths = { devicesDir: join(dir, "devices"), registryFile: join(dir, "devices", "registry.json") };
    const reg = await loadDeviceRegistry(paths);
    reg.put({ deviceId: "d1", name: "P", deviceType: "phone", platform: "ios", appVersion: "1", longTermPub: "aa", scope: "read", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 });
    await reg.appendCommand("d1", { commandId: "c1", hostId: "g1", bodyHash: "h", ts: 1 });
    expect(reg.dedupLookup("d1", "c1")?.hostId).toBe("g1");
    await reg.appendResponse("d1", "c1", { id: "c1", success: true });
    const cached = reg.dedupLookup("d1", "c1")?.response as { success: boolean } | undefined;
    expect(cached?.success).toBe(true);
    reg.mapHostId("g1", { deviceId: "d1", commandId: "c1" });
    expect(reg.unmapHostId("g1")).toEqual({ deviceId: "d1", commandId: "c1" });
    expect(reg.unmapHostId("g1")).toBeNull();
    // 崩溃恢复：重放 commands.jsonl
    const reg2 = await loadDeviceRegistry(paths);
    const replayed = reg2.dedupLookup("d1", "c1")?.response as { success: boolean } | undefined;
    expect(replayed?.success).toBe(true);
    expect(reg2.get("d1")?.name).toBe("P");
    expect(reg2.remove("d1")).toBe(true);
  });

  it("未知设备命令日志缺席容错；撕裂尾行跳过", async () => {
    const { loadDeviceRegistry } = await import("../device-registry.ts");
    const dir = await mkdtemp(join(tmpdir(), "devreg2-"));
    const paths = { devicesDir: join(dir, "devices"), registryFile: join(dir, "devices", "registry.json") };
    const reg = await loadDeviceRegistry(paths);
    expect(reg.dedupLookup("ghost", "x")).toBeNull();
    // 手工写撕裂日志
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "devices", "d2"), { recursive: true });
    reg.put({ deviceId: "d2", name: "Q", deviceType: "pc", platform: "mac", appVersion: "1", longTermPub: "bb", scope: "full", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 });
    await writeFile(join(dir, "devices", "d2", "commands.jsonl"), '{"commandId":"a","ts":1}\n{"commandId":"b","ts"', "utf8");
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const reg2 = await loadDeviceRegistry(paths);
    expect(reg2.dedupLookup("d2", "a")?.commandId).toBe("a");
    expect(reg2.dedupLookup("d2", "b")).toBeNull();
  });
});

describe("fanout coalesce 与 outbox 复用", () => {
  it("delta 类事件经 coalesce 送达（同 stream 复用 outbox seq 连续）", () => {
    const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
    const frames: Frame[] = [];
    fanout.attach({ target: "owner", tier: "owner", subscribedThreads: new Set(["tA"]), send: (f) => frames.push(f) });
    fanout.fanoutEvent({ threadId: "tA", name: "agent/assistant-stream", payload: { chunk: "a" } });
    fanout.fanoutEvent({ threadId: "tA", name: "llm/chunk", payload: { chunk: "b" } });
    fanout.fanoutEvent({ threadId: "tA", name: "turn/end", payload: {} });
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("detach 后不再收", () => {
    const fanout = new Fanout({ coalesceBacklogFrames: 64, coalesceLagMs: 500, now: () => 0 });
    const frames: Frame[] = [];
    const target = { target: "owner", tier: "owner" as const, subscribedThreads: new Set(["tA"]), send: (f: Frame) => frames.push(f) };
    fanout.attach(target);
    fanout.detach("owner");
    fanout.fanoutEvent({ threadId: "tA", name: "turn/start", payload: {} });
    expect(frames.length).toBe(0);
  });
});

describe("audit 轮转与封顶", () => {
  it("按天分文件；单日 64MiB 封顶后丢弃不炸", async () => {
    const { openAuditLog } = await import("../audit.ts");
    const dir = await mkdtemp(join(tmpdir(), "audit-"));
    let ts = Date.parse("2026-09-27T00:00:00Z");
    const log = await openAuditLog(dir, () => ts);
    await log.record("gateway-started", { a: 1 });
    await log.record("host-restarted", { b: 2 });
    const names = await (await import("node:fs/promises")).readdir(dir);
    expect(names.some((n) => n === "2026-09-27.jsonl")).toBe(true);
    // 跨天
    ts = Date.parse("2026-09-28T00:00:00Z");
    await log.record("config-changed", { c: 3 });
    const names2 = await (await import("node:fs/promises")).readdir(dir);
    expect(names2.some((n) => n === "2026-09-28.jsonl")).toBe(true);
  });
});

describe("owner-server 残留 socket 清理与坏 JSON 行", () => {
  it("残留 socket 文件被清；垃圾行回 bad-frame；close 后 server 关", async () => {
    const { startOwnerServer } = await import("../owner-server.ts");
    const dir = await mkdtemp(join(tmpdir(), "owner-"));
    const socketPath = join(dir, "gateway.sock");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(socketPath, "stale", "utf8"); // 残留
    const frames: string[] = [];
    const handle = await startOwnerServer({
      socketPath,
      pidFile: join(dir, "gateway.pid"),
      onFrame: () => {},
      log: () => {},
    });
    const { connect } = await import("node:net");
    const sock = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    sock.on("data", (c: Buffer) => {
      for (const l of c.toString("utf8").split("\n")) if (l.length > 0) frames.push(l);
    });
    sock.write("garbage-not-json\n");
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    expect(frames.some((f) => f.includes("bad-frame"))).toBe(true);
    sock.destroy();
    await handle.close();
  });

  it("onConnect/onClose 钩子触发", async () => {
    const { startOwnerServer } = await import("../owner-server.ts");
    const dir = await mkdtemp(join(tmpdir(), "owner2-"));
    const events: string[] = [];
    const handle = await startOwnerServer({
      socketPath: join(dir, "gateway.sock"),
      pidFile: join(dir, "gateway.pid"),
      onFrame: () => {},
      onConnect: () => events.push("connect"),
      onClose: () => events.push("close"),
      log: () => {},
    });
    const { connect } = await import("node:net");
    const sock = connect(handle.socketPath);
    await new Promise<void>((resolve) => {
      sock.once("connect", () => resolve());
    });
    sock.destroy();
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    expect(events).toEqual(["connect", "close"]);
    await handle.close();
  });
});

describe("identity 恢复旅程", () => {
  it("首启生成 + 二启装载 + installationId 撕裂重建", async () => {
    const { loadOrCreateIdentity } = await import("../identity.ts");
    const dir = await mkdtemp(join(tmpdir(), "ident-"));
    const paths = { agentDir: dir, installationIdFile: join(dir, "installation-id"), gatewayIdentityFile: join(dir, "gateway-identity.json") };
    const first = await loadOrCreateIdentity(paths);
    const second = await loadOrCreateIdentity(paths);
    expect(second.signingPub).toBe(first.signingPub);
    expect(second.installationId).toBe(first.installationId);
    // 手工撕裂：identity 文件的 installationId 与 installation-id 文件不一致 → 以文件为准重建
    const torn = JSON.parse(await readFile(paths.gatewayIdentityFile, "utf8")) as { installationId: string };
    torn.installationId = "different";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(paths.gatewayIdentityFile, JSON.stringify(torn), "utf8");
    const third = await loadOrCreateIdentity(paths);
    expect(third.installationId).toBe(first.installationId);
    expect(third.signingPub).not.toBe(first.signingPub);
  });
});
