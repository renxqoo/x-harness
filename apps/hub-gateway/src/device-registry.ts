import { mkdir, readFile } from "node:fs/promises";
import { atomicWrite } from "./identity.ts";
import { COMMAND_LOG_RING_MAX } from "@x-harness/remote-protocol";
import { join } from "node:path";
import {
  COMMAND_LOG_BYTES_CAP,
  appendCommandLogLine,
  compactCommandLog,
  readMergedCommandLog,
  removeCommandLogSync,
  takeWithinBytes,
} from "./command-log-file.ts";

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

const commandLogPath = (devicesDir: string, deviceId: string): string => join(devicesDir, deviceId, "commands.jsonl");

export interface DeviceRegistry {
  list(): DeviceEntry[];
  get(deviceId: string): DeviceEntry | null;
  put(entry: DeviceEntry): void;
  remove(deviceId: string): boolean;
  appendCommand(deviceId: string, record: CommandLogRecord): Promise<void>;
  appendResponse(deviceId: string, commandId: string, response: unknown): Promise<void>;
  dedupLookup(deviceId: string, commandId: string): CommandLogRecord | null;
  mapHostId(hostId: string, owner: { deviceId: string; commandId: string }): void;
  unmapHostId(hostId: string): { deviceId: string; commandId: string } | null;
  pendingHostIds(): Array<{ hostId: string; deviceId: string; commandId: string }>;
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
  const commandLog = new Map<string, CommandLogRecord[]>();
  const commandLogBytes = new Map<string, number>();
  const hostIdMap = new Map<string, { deviceId: string; commandId: string }>();
  for (const device of devices) {
    const logPath = commandLogPath(paths.devicesDir, device.deviceId);
    const merged = (await readMergedCommandLog(logPath)).filter(isCommandLogRecord);
    const finalRecords = takeWithinBytes(merged.slice(-COMMAND_LOG_RING_MAX), COMMAND_LOG_BYTES_CAP);
    commandLog.set(device.deviceId, finalRecords);
    // 启动即压缩落盘：环形缓冲只在内存里生效的话，磁盘文件会随远程轮询无限增长
    await compactCommandLog(logPath, finalRecords, COMMAND_LOG_BYTES_CAP);
    commandLogBytes.set(device.deviceId, byteSizeOfAll(finalRecords));
    for (const rec of finalRecords) {
      if (rec.hostId !== null && rec.response === undefined) {
        hostIdMap.set(rec.hostId, { deviceId: device.deviceId, commandId: rec.commandId });
      }
    }
  }
  let registryWriteTail: Promise<void> = Promise.resolve();
  const persistRegistry = (): Promise<void> => {
    registryWriteTail = registryWriteTail.then(() =>
      atomicWrite(paths.registryFile, JSON.stringify({ devices: [...byId.values()] }, null, 2)),
    );
    return registryWriteTail;
  };
  await persistRegistry();

  /** 追加一条记录并守住字节上限：未超限走追加，超限则把内存里已截断的列表整体重写落盘。
   * 返回落盘后的记录集，调用方据此同步内存环形缓冲。字节数增量维护，避免每次全量重算。 */
  async function appendWithinBytesCap(
    deviceId: string,
    list: readonly CommandLogRecord[],
    record: CommandLogRecord,
  ): Promise<CommandLogRecord[]> {
    const logPath = commandLogPath(paths.devicesDir, deviceId);
    const appended = await appendCommandLogLine(logPath, record);
    const projected = (commandLogBytes.get(deviceId) ?? 0) + appended;
    if (projected <= COMMAND_LOG_BYTES_CAP) {
      commandLogBytes.set(deviceId, projected);
      return [...list];
    }
    const kept = takeWithinBytes(list, COMMAND_LOG_BYTES_CAP);
    await compactCommandLog(logPath, kept, COMMAND_LOG_BYTES_CAP);
    commandLogBytes.set(deviceId, byteSizeOfAll(kept));
    return kept;
  }

  return {
    list: () => [...byId.values()],
    get: (deviceId) => byId.get(deviceId) ?? null,
    put(entry) {
      byId.set(entry.deviceId, entry);
      persistRegistry();
    },
    remove(deviceId) {
      const hit = byId.delete(deviceId);
      if (hit) {
        commandLog.delete(deviceId);
        commandLogBytes.delete(deviceId);
        removeCommandLogSync(commandLogPath(paths.devicesDir, deviceId));
        persistRegistry();
      }
      return hit;
    },
    async appendCommand(deviceId, record) {
      const list = commandLog.get(deviceId) ?? [];
      list.push(record);
      if (list.length > COMMAND_LOG_RING_MAX) {
        list.splice(0, list.length - COMMAND_LOG_RING_MAX);
        commandLogBytes.set(deviceId, byteSizeOfAll(list));
      }
      commandLog.set(deviceId, list);
      if (record.hostId !== null) hostIdMap.set(record.hostId, { deviceId, commandId: record.commandId });
      await mkdir(join(paths.devicesDir, deviceId), { recursive: true });
      commandLog.set(deviceId, await appendWithinBytesCap(deviceId, list, record));
    },
    async appendResponse(deviceId, commandId, response) {
      const list = commandLog.get(deviceId) ?? [];
      const record = [...list].reverse().find((r) => r.commandId === commandId);
      if (record === undefined) return;
      const before = byteSizeOf(record);
      record.response = response;
      const delta = byteSizeOf(record) - before;
      if (delta !== 0) commandLogBytes.set(deviceId, (commandLogBytes.get(deviceId) ?? 0) + delta);
      if (record.hostId !== null) hostIdMap.delete(record.hostId);
      await mkdir(join(paths.devicesDir, deviceId), { recursive: true });
      commandLog.set(deviceId, await appendWithinBytesCap(deviceId, list, record));
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
    pendingHostIds() {
      return [...hostIdMap.entries()].map(([hostId, owner]) => ({ hostId, deviceId: owner.deviceId, commandId: owner.commandId }));
    },
  };
}

function isCommandLogRecord(value: unknown): value is CommandLogRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Partial<CommandLogRecord>;
  return typeof rec.commandId === "string" && typeof rec.ts === "number";
}

function byteSizeOf(record: CommandLogRecord): number {
  return Buffer.byteLength(JSON.stringify(record)) + 1;
}

function byteSizeOfAll(records: readonly CommandLogRecord[]): number {
  return records.reduce((sum, rec) => sum + byteSizeOf(rec), 0);
}