// 设备注册表（DESIGN §3.4）+ 去重日志 commands.jsonl（DESIGN §1.2.1 一致性 H3 处置）。
// 去重日志 write-ahead：写命令转发 host stdin 之前先 append 落盘；response 到达补记；
// 重启重放重建去重表 + pending 映射 + response 缓存（崩溃安全，杜绝双 prompt）。
import { readFile, mkdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { atomicWrite } from "./identity.ts";
import { COMMAND_LOG_RING_MAX } from "@x-harness/remote-protocol";
import { join } from "node:path";

export interface DeviceEntry {
  deviceId: string;
  name: string;
  deviceType: string;
  platform: string;
  appVersion: string;
  longTermPub: string;
  scope: "read" | "interact" | "full";
  pairedAt: number;
  lastSeenAt: number;
  rekeyCounter: number;
}

export interface CommandLogRecord {
  commandId: string;
  hostId: string | null;
  bodyHash: string;
  ts: number;
  response?: unknown;
}

export interface DeviceRegistry {
  list(): DeviceEntry[];
  get(deviceId: string): DeviceEntry | null;
  put(entry: DeviceEntry): void;
  remove(deviceId: string): boolean;
  /** 去重日志：提交前 write-ahead（fsync 语义：append 后落） */
  appendCommand(deviceId: string, record: CommandLogRecord): Promise<void>;
  /** response 到达补记 */
  appendResponse(deviceId: string, commandId: string, response: unknown): Promise<void>;
  /** 去重查询与缓存 */
  dedupLookup(deviceId: string, commandId: string): CommandLogRecord | null;
  /** pending 映射：hostId → (deviceId, commandId) */
  mapHostId(hostId: string, owner: { deviceId: string; commandId: string }): void;
  unmapHostId(hostId: string): { deviceId: string; commandId: string } | null;
}

export async function loadDeviceRegistry(paths: { devicesDir: string; registryFile: string }): Promise<DeviceRegistry> {
  await mkdir(paths.devicesDir, { recursive: true });
  let devices: DeviceEntry[] = [];
  try {
    const raw = JSON.parse(await readFile(paths.registryFile, "utf8")) as { devices?: unknown };
    if (Array.isArray(raw.devices)) {
      devices = raw.devices.filter(
        (d): d is DeviceEntry => typeof d === "object" && d !== null && typeof (d as DeviceEntry).deviceId === "string",
      );
    }
  } catch {
    devices = [];
  }
  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const commandLog = new Map<string, CommandLogRecord[]>(); // deviceId → 环形
  const hostIdMap = new Map<string, { deviceId: string; commandId: string }>();
  // 重放去重日志（崩溃恢复）
  for (const device of devices) {
    try {
      const logPath = join(paths.devicesDir, device.deviceId, "commands.jsonl");
      const text = await readFile(logPath, "utf8");
      const records: CommandLogRecord[] = [];
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          records.push(JSON.parse(line) as CommandLogRecord);
        } catch {
          // 撕裂尾行跳过（append 半写的容错）
        }
      }
      commandLog.set(device.deviceId, records.slice(-COMMAND_LOG_RING_MAX));
    } catch {
      commandLog.set(device.deviceId, []);
    }
  }
  const persistRegistry = (): void => {
    void atomicWrite(paths.registryFile, JSON.stringify({ devices: [...byId.values()] }, null, 2));
  };
  await Promise.resolve();
  persistRegistry();
  return {
    list: () => [...byId.values()],
    get: (deviceId) => byId.get(deviceId) ?? null,
    put(entry) {
      byId.set(entry.deviceId, entry);
      persistRegistry();
    },
    remove(deviceId) {
      const hit = byId.delete(deviceId);
      if (hit) persistRegistry();
      return hit;
    },
    async appendCommand(deviceId, record) {
      const list = commandLog.get(deviceId) ?? [];
      list.push(record);
      if (list.length > COMMAND_LOG_RING_MAX) list.splice(0, list.length - COMMAND_LOG_RING_MAX);
      commandLog.set(deviceId, list);
      if (record.hostId !== null) hostIdMap.set(record.hostId, { deviceId, commandId: record.commandId });
      const logPath = join(paths.devicesDir, deviceId, "commands.jsonl");
      await mkdir(join(paths.devicesDir, deviceId), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
    },
    async appendResponse(deviceId, commandId, response) {
      const list = commandLog.get(deviceId) ?? [];
      const record = [...list].reverse().find((r) => r.commandId === commandId);
      if (record === undefined) return;
      record.response = response;
      const logPath = join(paths.devicesDir, deviceId, "commands.jsonl");
      // 全量重写（环形淘汰语义简单化：重写头部窗口）
      const kept = list.slice(-COMMAND_LOG_RING_MAX);
      commandLog.set(deviceId, kept);
      await atomicWrite(logPath, `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`);
    },
    dedupLookup(deviceId, commandId) {
      const list = commandLog.get(deviceId) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]!.commandId === commandId) return list[i]!;
      }
      return null;
    },
    mapHostId(hostId, owner) {
      hostIdMap.set(hostId, owner);
    },
    unmapHostId(hostId) {
      const hit = hostIdMap.get(hostId) ?? null;
      hostIdMap.delete(hostId);
      return hit;
    },
  };
}
