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
  const hostIdMap = new Map<string, { deviceId: string; commandId: string }>();
  for (const device of devices) {
    try {
      const logPath = join(paths.devicesDir, device.deviceId, "commands.jsonl");
      const text = await readFile(logPath, "utf8");
      const merged = new Map<string, CommandLogRecord>();
      hostIdMap.clear();
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          const rec = JSON.parse(line) as CommandLogRecord;
          const prev = merged.get(rec.commandId);
          merged.set(rec.commandId, prev === undefined || prev.response === undefined ? rec : { ...rec, response: rec.response ?? prev.response });
        } catch {
        }
      }
      const finalRecords = [...merged.values()].slice(-COMMAND_LOG_RING_MAX);
      commandLog.set(device.deviceId, finalRecords);
      for (const rec of finalRecords) {
        if (rec.hostId !== null && rec.response === undefined) {
          hostIdMap.set(rec.hostId, { deviceId: device.deviceId, commandId: rec.commandId });
        }
      }
    } catch {
      commandLog.set(device.deviceId, []);
    }
  }
  let registryWriteTail: Promise<void> = Promise.resolve();
  const persistRegistry = (): Promise<void> => {
    registryWriteTail = registryWriteTail.then(() => atomicWrite(paths.registryFile, JSON.stringify({ devices: [...byId.values()] }, null, 2)));
    return registryWriteTail;
  };
  await persistRegistry();
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
      if (record.hostId !== null) hostIdMap.delete(record.hostId);
      const logPath = join(paths.devicesDir, deviceId, "commands.jsonl");
      await mkdir(join(paths.devicesDir, deviceId), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
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
