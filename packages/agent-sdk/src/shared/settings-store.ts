import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROFILE_IDS, profileRowValid } from "@x-harness/permission";
import type { PermissionProfile, ProfileId, RuleEntry, RuleNature, RuleTool, Verdict } from "@x-harness/permission";
import type { ThinkingLevel } from "@x-harness/llm";
import { activeAtomicPaths, atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubError, type HubErrorShape } from "./errors.ts";
import { hubLog } from "./hub-log.ts";

export interface HubSettings {
  "permission.defaultMode"?: ProfileId;
  "permission.rules"?: RuleEntry[];
  "permission.profiles"?: PermissionProfile[];
  "thinking.default"?: ThinkingLevel;
  "skills.disabled"?: string[];
  "plugins.disabled"?: string[];
  "compaction.keepRecentTokens"?: number;
  "compaction.keepMinTurns"?: number;
}

export type HubSettingsKey = keyof HubSettings;

const PERM_MODES: readonly ProfileId[] = [...PROFILE_IDS];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const RULE_TOOLS: readonly RuleTool[] = ["Danger", "Read", "Write", "Tool"];
const RULE_VERDICTS: readonly Verdict[] = ["allow", "deny", "ask"];
const RULE_NATURES: readonly RuleNature[] = ["handwritten", "grant"];
export const PROJECT_DATA_DIR = ".x-harness";

function profilesValueValid(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(profileRowValid)) return false;
  return value.every((row): boolean => typeof row === "object" && row !== null && !(PROFILE_IDS as readonly string[]).includes((row as { id?: unknown }).id as string));
}

export function validateSettingValue(key: string, value: unknown): { ok: true; key: HubSettingsKey } | { ok: false; error: HubErrorShape } {
  const validators: Record<string, (value: unknown) => boolean> = {
    "permission.defaultMode": (value) => typeof value === "string" && PERM_MODES.includes(value as ProfileId),
    "permission.rules": (value) => Array.isArray(value) && value.every(ruleEntryValid),
    "permission.profiles": profilesValueValid,
    "thinking.default": (value) => typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel),
    "skills.disabled": (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== ""),
    "plugins.disabled": (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== ""),
    "compaction.keepRecentTokens": (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "compaction.keepMinTurns": (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  };
  const validator = validators[key];
  if (validator === undefined) {
    return { ok: false, error: hubError("invalid_input", `unknown setting key: ${key}`) };
  }
  if (!validator(value)) {
    return { ok: false, error: hubError("invalid_input", `invalid setting value: ${key}`) };
  }
  return { ok: true, key: key as HubSettingsKey };
}

function ruleEntryValid(value: unknown): value is RuleEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["tool"] === "string" &&
    RULE_TOOLS.includes(r["tool"] as RuleTool) &&
    typeof r["pattern"] === "string" &&
    r["pattern"] !== "" &&
    typeof r["verdict"] === "string" &&
    RULE_VERDICTS.includes(r["verdict"] as Verdict) &&
    typeof r["nature"] === "string" &&
    RULE_NATURES.includes(r["nature"] as RuleNature) &&
    (r["nature"] !== "grant" || r["verdict"] === "allow") &&
    (r["at"] === undefined || typeof r["at"] === "number")
  );
}

function isKnownKey(key: string): key is HubSettingsKey {
  return key === "permission.defaultMode" || key === "permission.rules" || key === "permission.profiles" || key === "thinking.default" || key === "skills.disabled" || key === "plugins.disabled" || key === "compaction.keepRecentTokens" || key === "compaction.keepMinTurns";
}

export async function readSettingsFile(path: string): Promise<HubSettings> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return {};
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    hubLog(`settings unreadable; degraded to defaults (${path})`);
    return {};
  }
  const out: HubSettings = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isKnownKey(key)) {
      const verdict = validateSettingValue(key, value);
      if (verdict.ok) out[key] = value as never;
      else if (key === "permission.rules" && Array.isArray(value)) {
        const kept = value.filter(ruleEntryValid);
        for (const dropped of value.filter((entry) => !ruleEntryValid(entry))) {
          hubLog(`settings: dropped invalid permission rule entry (断代词条或畸形——${JSON.stringify(dropped)})`);
        }
        if (kept.length > 0) out[key] = kept as never;
      }
    }
  }
  const mode = out["permission.defaultMode"];
  if (mode === undefined && typeof parsed["permission.defaultMode"] === "string") {
    const profiles = Array.isArray(parsed["permission.profiles"]) ? (parsed["permission.profiles"] as unknown[]) : [];
    const hit = profiles.some((row) => typeof row === "object" && row !== null && (row as { id?: unknown }).id === parsed["permission.defaultMode"] && profileRowValid(row));
    if (hit) out["permission.defaultMode"] = parsed["permission.defaultMode"] as never;
  }
  return out;
}

export function readHubSettings(agentDir: string): Promise<HubSettings> {
  return readSettingsFile(userSettingsPath(agentDir));
}

export function userSettingsPath(agentDir: string): string {
  return join(agentDir, "hub-settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_DATA_DIR, "hub-settings.json");
}

export function readProjectSettings(cwd: string): Promise<HubSettings> {
  return readSettingsFile(projectSettingsPath(cwd));
}

export function writeHubSettings(agentDir: string, next: HubSettings): Promise<void> {
  return atomicWriteJson(userSettingsPath(agentDir), next);
}

export async function normalizeCwd(raw: string): Promise<string> {
  const trimmed = raw.endsWith("/") && raw !== "/" ? raw.slice(0, -1) : raw;
  const real = await realpath(trimmed).catch(() => undefined);
  return real ?? resolve(trimmed);
}

export function updateSettingsFile(path: string, mutate: (current: HubSettings) => HubSettings | Promise<HubSettings>): Promise<HubSettings> {
  return updateJson<HubSettings>(path, {
    read: () => readSettingsFile(path),
    write: (next) => atomicWriteJson(path, next),
    mutate,
  });
}

export function updateHubSettings(agentDir: string, mutate: (current: HubSettings) => HubSettings | Promise<HubSettings>): Promise<HubSettings> {
  return updateSettingsFile(userSettingsPath(agentDir), mutate);
}

export function activeSettingPaths(): number {
  return activeAtomicPaths();
}

export function mergeSettings(user: HubSettings, project: HubSettings): { values: HubSettings; sources: Record<string, "project" | "user" | "union"> } {
  const values: HubSettings = {};
  const sources: Record<string, "project" | "user" | "union"> = {};
  const overlay: Array<keyof HubSettings> = ["permission.defaultMode", "thinking.default"];
  for (const key of overlay) {
    const fromProject = project[key];
    const fromUser = user[key];
    if (fromProject !== undefined) {
      (values[key] as unknown) = fromProject;
      sources[key] = "project";
    } else if (fromUser !== undefined) {
      (values[key] as unknown) = fromUser;
      sources[key] = "user";
    }
  }
  const unionKeys = ["skills.disabled", "plugins.disabled"] as const;
  for (const key of unionKeys) {
    const union = [...new Set([...(user[key] ?? []), ...(project[key] ?? [])])].sort();
    if (union.length > 0) {
      (values[key] as unknown) = union;
      sources[key] = "union";
    }
  }
  mergeInto({ values, sources }, "permission.rules", mergeRuleEntries(user, project));
  mergeInto({ values, sources }, "permission.profiles", mergeProfileRows(user, project));
  return { values, sources };
}

function mergeInto<T>(target: { values: HubSettings; sources: Record<string, "project" | "user" | "union"> }, key: keyof HubSettings, merged: readonly T[]): void {
  if (merged.length === 0) return;
  (target.values[key] as unknown) = merged;
  target.sources[key as string] = "union";
}

function mergeRuleEntries(user: HubSettings, project: HubSettings): readonly RuleEntry[] {
  const byKey = new Map<string, RuleEntry>();
  for (const entry of [...(user["permission.rules"] ?? []), ...(project["permission.rules"] ?? [])]) {
    const key = `${entry.tool}\u0000${entry.pattern}`;
    const existing = byKey.get(key);
    if (existing !== undefined && existing.verdict === "deny") continue;
    if (existing !== undefined && entry.verdict === "deny") {
      byKey.set(key, entry);
      continue;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => `${a.tool}:${a.pattern}`.localeCompare(`${b.tool}:${b.pattern}`));
}

function mergeProfileRows(user: HubSettings, project: HubSettings): readonly PermissionProfile[] {
  const byId = new Map<string, PermissionProfile>();
  for (const row of [...(user["permission.profiles"] ?? []), ...(project["permission.profiles"] ?? [])]) {
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
