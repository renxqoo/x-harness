// 插件清单文件（单一真相）：<agentDir>/plugins/registry.json。vendor 件安装事实的
// 持久层——settings 是数据不是代码红线在本域的落法：registry 只记名字/哈希/审批
// 事实，装载时每条仍走哈希 pin + approveInstall + 引擎门，不是路径直装。
// 形态对齐 settings-store：坏文件降级空清单（安全向 = 回到全 builtin）、原子写、
// 坏条目逐条丢弃（单条坏不拖垮整文件）。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activeAtomicPaths, atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubLog } from "./hub-log.ts";
import { builtinPluginNames } from "./plugins-catalog.ts";

export interface VendorPluginEntry {
  readonly name: string;
  /** vendor 根内相对目录名（恒等于 name——目录隔离即名字隔离） */
  readonly dir: string;
  readonly sha256: string;
  readonly approvedBy: "user";
  readonly approvedAt: number;
  readonly apiVersion: number;
  /** 注册发起方（manual = 管理页手选；agent = plugin_propose 链确认） */
  readonly origin: "manual" | "agent";
  /** 安装时 manifest.description 快照（list/管理页展示——不参与判定） */
  readonly description?: string;
}

/** 条目形状校验（单点——读文件面与写入面同判定） */
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";
const isOptional = (value: unknown, pred: (v: unknown) => boolean): boolean => value === undefined || pred(value);

export function vendorEntryValid(value: unknown): value is VendorPluginEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (!isNonEmptyString(r["name"]) || !isNonEmptyString(r["dir"]) || !isNonEmptyString(r["sha256"])) return false;
  if (r["approvedBy"] !== "user") return false;
  if (typeof r["approvedAt"] !== "number" || typeof r["apiVersion"] !== "number" || !Number.isInteger(r["apiVersion"])) return false;
  if (!isOptional(r["origin"], (v) => v === "manual" || v === "agent")) return false;
  return isOptional(r["description"], (v) => typeof v === "string");
}

export function registryPath(agentDir: string): string {
  return join(agentDir, "plugins", "registry.json");
}

export function vendorRootOf(agentDir: string): string {
  return join(agentDir, "plugins", "vendor");
}

/** 读清单（坏文件降级空 + hubLog 诊断；坏条目丢弃） */
export async function readVendorRegistry(agentDir: string): Promise<VendorPluginEntry[]> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(registryPath(agentDir)).text();
  } catch {
    return []; // 缺席（首跑常态）
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    hubLog(`plugin registry unreadable; degraded to empty (${registryPath(agentDir)})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    hubLog(`plugin registry malformed; degraded to empty (${registryPath(agentDir)})`);
    return [];
  }
  const entries: VendorPluginEntry[] = [];
  for (const item of parsed) {
    if (vendorEntryValid(item)) entries.push(item);
  }
  return entries;
}

/** 撞名拒（P3）：vendor 名 ∈ builtin 词表 → 拒写入（清单层拒绝，不留给装载层兜底） */
export function vendorNameBlocked(name: string): boolean {
  return builtinPluginNames().includes(name);
}

/** 串行读改写（atomic-file 单点） */
export function updateVendorRegistry(
  agentDir: string,
  mutate: (current: VendorPluginEntry[]) => VendorPluginEntry[] | Promise<VendorPluginEntry[]>,
): Promise<VendorPluginEntry[]> {
  return updateJson<VendorPluginEntry[]>(registryPath(agentDir), {
    read: () => readVendorRegistry(agentDir),
    write: async (next) => {
      await mkdir(join(agentDir, "plugins"), { recursive: true });
      await atomicWriteJson(registryPath(agentDir), next);
    },
    mutate,
  });
}

/** 整替写（安装编排用——经 update 链保持串行） */
export async function writeVendorRegistry(agentDir: string, next: VendorPluginEntry[]): Promise<void> {
  await updateVendorRegistry(agentDir, () => next);
}

/** 写链活跃路径数（测试口径与 settings 对齐） */
export function activeRegistryPaths(): number {
  return activeAtomicPaths();
}
