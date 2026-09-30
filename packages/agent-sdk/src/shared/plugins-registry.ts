import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { activeAtomicPaths, atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubLog } from "./hub-log.ts";
import { builtinPluginNames } from "./plugins-catalog.ts";

export interface VendorPluginEntry {
  readonly name: string;
  readonly dir: string;
  readonly sha256: string;
  readonly approvedBy: "user";
  readonly approvedAt: number;
  readonly apiVersion: number;
  readonly origin: "manual" | "agent";
  readonly description?: string;
}

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

export async function readVendorRegistry(agentDir: string): Promise<VendorPluginEntry[]> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(registryPath(agentDir)).text();
  } catch {
    return [];
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

export function vendorNameBlocked(name: string): boolean {
  return builtinPluginNames().includes(name);
}

export function updateVendorRegistry(
  agentDir: string,
  mutate: (current: VendorPluginEntry[]) => VendorPluginEntry[] | Promise<VendorPluginEntry[]>,
): Promise<VendorPluginEntry[]> {
  return updateJson<VendorPluginEntry[]>(registryPath(agentDir), {
    read: () => readVendorRegistry(agentDir),
    write: async (next) => {
      const clash = next.find((entry) => vendorNameBlocked(entry.name));
      if (clash !== undefined) {
        throw new Error(`vendor plugin name conflicts with builtin: ${clash.name}`);
      }
      await mkdir(join(agentDir, "plugins"), { recursive: true });
      await atomicWriteJson(registryPath(agentDir), next);
    },
    mutate,
  });
}

export async function writeVendorRegistry(agentDir: string, next: VendorPluginEntry[]): Promise<void> {
  await updateVendorRegistry(agentDir, () => next);
}

export function activeRegistryPaths(): number {
  return activeAtomicPaths();
}
