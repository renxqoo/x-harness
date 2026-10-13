import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceRegistry, type CommandLogRecord, type DeviceEntry } from "../device-registry.ts";
import { COMMAND_LOG_BYTES_CAP, takeWithinBytes } from "../command-log-file.ts";

function entry(deviceId: string): DeviceEntry {
  return {
    deviceId,
    name: deviceId,
    deviceType: "phone",
    platform: "ios",
    appVersion: "1",
    longTermPub: "pub",
    scope: "interact",
    pairedAt: 1,
    lastSeenAt: 1,
    rekeyCounter: 0,
  };
}

async function fixtureRoot(): Promise<{ devicesDir: string; registryFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "cmdlog-"));
  const devicesDir = join(root, "devices");
  await mkdir(devicesDir, { recursive: true });
  const registryFile = join(devicesDir, "registry.json");
  await writeFile(registryFile, JSON.stringify({ devices: [entry("d_test")] }), "utf8");
  return { devicesDir, registryFile };
}

describe("命令日志落盘封顶（症状：远程轮询把 commands.jsonl 堆到 300 MB 且重启不收敛）", () => {
  it("启动即把超限的历史日志压缩到字节上限内", async () => {
    const { devicesDir, registryFile } = await fixtureRoot();
    const logPath = join(devicesDir, "d_test", "commands.jsonl");
    await mkdir(join(devicesDir, "d_test"), { recursive: true });
    // 模拟旧版本留下的无界文件：每条 32 KB，总量远超上限
    const chunk = "x".repeat(32 * 1024);
    const lines = Array.from({ length: 1200 }, (_, i) =>
      JSON.stringify({ commandId: `c${i}`, hostId: null, bodyHash: "h", ts: i, response: { data: chunk } }),
    );
    await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");
    const before = (await stat(logPath)).size;
    expect(before).toBeGreaterThan(COMMAND_LOG_BYTES_CAP);

    const registry = await loadDeviceRegistry({ devicesDir, registryFile });

    const after = (await stat(logPath)).size;
    expect(after).toBeLessThanOrEqual(COMMAND_LOG_BYTES_CAP);
    expect(after).toBeLessThan(before);
    // 压缩不得丢掉最新的记录（幂等去重回放依赖它）
    const onDisk = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    expect(JSON.parse(onDisk[onDisk.length - 1]!).commandId).toBe("c1199");
    expect(registry.dedupLookup("d_test", "c1199")?.commandId).toBe("c1199");
  });

  it("追加超过字节上限后文件被重写压缩，而不是继续增长", async () => {
    const { devicesDir, registryFile } = await fixtureRoot();
    const registry = await loadDeviceRegistry({ devicesDir, registryFile });
    const logPath = join(devicesDir, "d_test", "commands.jsonl");
    const chunk = "y".repeat(64 * 1024);
    // 单条 64 KB → 约 512 条触顶
    for (let i = 0; i < 600; i += 1) {
      await registry.appendCommand("d_test", {
        commandId: `c${i}`,
        hostId: null,
        bodyHash: "h",
        ts: i,
        response: { data: chunk },
      } satisfies CommandLogRecord);
    }
    const size = (await stat(logPath)).size;
    expect(size).toBeLessThanOrEqual(COMMAND_LOG_BYTES_CAP);
    expect(registry.dedupLookup("d_test", "c599")?.commandId).toBe("c599");
  });

  it("重启后仍未应答命令的 hostId 映射仍在（网关重启后要能补投响应）", async () => {
    const { devicesDir, registryFile } = await fixtureRoot();
    const first = await loadDeviceRegistry({ devicesDir, registryFile });
    await first.appendCommand("d_test", { commandId: "c1", hostId: "g_pending", bodyHash: "h", ts: 1 });
    await first.appendResponse("d_test", "c2", { ok: true });

    const reopened = await loadDeviceRegistry({ devicesDir, registryFile });
    expect(reopened.pendingHostIds()).toEqual([{ hostId: "g_pending", deviceId: "d_test", commandId: "c1" }]);
  });

  it("撤销设备会连同其命令日志目录一起清掉", async () => {
    const { devicesDir, registryFile } = await fixtureRoot();
    const registry = await loadDeviceRegistry({ devicesDir, registryFile });
    await registry.appendCommand("d_test", { commandId: "c1", hostId: null, bodyHash: "h", ts: 1 });
    expect(registry.remove("d_test")).toBe(true);
    await expect(stat(join(devicesDir, "d_test", "commands.jsonl"))).rejects.toThrow();
    expect(registry.list()).toEqual([]);
  });
});

describe("takeWithinBytes（字节上限回取：至少留一条，保证未应答命令不丢映射）", () => {
  it("超出上限时丢最旧的", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ commandId: `c${i}`, ts: i, blob: "aaaa" }));
    const kept = takeWithinBytes(records, 40);
    expect(kept.length).toBeLessThan(records.length);
    expect(kept[kept.length - 1]!.commandId).toBe("c9");
    expect(kept[0]!.commandId).not.toBe("c0");
  });

  it("单条就超上限时仍保留该条（否则 pending 映射全丢）", () => {
    const records = [{ commandId: "only", ts: 1, blob: "z".repeat(500) }];
    const kept = takeWithinBytes(records, 10);
    expect(kept).toHaveLength(1);
  });
});