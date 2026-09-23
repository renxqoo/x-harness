// hub 运行时设置（DESIGN §3.9）：<agentDir>/hub-settings.json（用户级）与
// <cwd>/.x-harness/hub-settings.json（项目级）。host（命令面读写）与 worker（装配期
// 快照读）共享；白名单键校验单点；坏文件降级空表（安全向：permission 回落 auto）；
// 原子写（tmp + rename）；写链按绝对路径分链 + 空闲回收（防泄漏不破串行）。
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
}

export type HubSettingsKey = keyof HubSettings;

const PERM_MODES: readonly ProfileId[] = [...PROFILE_IDS];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const RULE_TOOLS: readonly RuleTool[] = ["Bash", "Read", "Write", "Grep", "Tool"];
const RULE_VERDICTS: readonly Verdict[] = ["allow", "deny", "ask"];
const RULE_NATURES: readonly RuleNature[] = ["handwritten", "grant"];
/** 项目数据目录名（x-harness 约定：内核 skills/agents 目录同根） */
export const PROJECT_DATA_DIR = ".x-harness";

/** profiles 值校验：逐行形态 + 内置保留名拒（自定义档不得 shadow 出厂行） */
function profilesValueValid(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(profileRowValid)) return false;
  return value.every((row): boolean => typeof row === "object" && row !== null && !(PROFILE_IDS as readonly string[]).includes((row as { id?: unknown }).id as string));
}

/** 键白名单 + 值校验（单点——settings/set 的唯一判定面；恒 invalid_input 族） */
export function validateSettingValue(key: string, value: unknown): { ok: true; key: HubSettingsKey } | { ok: false; error: HubErrorShape } {
  const validators: Record<string, (value: unknown) => boolean> = {
    "permission.defaultMode": (value) => typeof value === "string" && PERM_MODES.includes(value as ProfileId),
    "permission.rules": (value) => Array.isArray(value) && value.every(ruleEntryValid),
    "permission.profiles": profilesValueValid,
    "thinking.default": (value) => typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel),
    "skills.disabled": (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== ""),
    "plugins.disabled": (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== ""),
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

/** 规则条目形态（文件面与命令面同判定——fail-closed；grant 性质恒 allow） */
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
  return key === "permission.defaultMode" || key === "permission.rules" || key === "permission.profiles" || key === "thinking.default" || key === "skills.disabled" || key === "plugins.disabled";
}

/** 读指定路径设置文件（坏文件/缺席降级空表——坏文件带 stderr 诊断；逐键校验丢弃坏值） */
export async function readSettingsFile(path: string): Promise<HubSettings> {
  let raw: string | undefined;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return {}; // 缺席（首跑常态）
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    hubLog(`settings unreadable; degraded to defaults (${path})`);
    return {}; // 坏文件降级（安全向）
  }
  const out: HubSettings = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isKnownKey(key)) {
      const verdict = validateSettingValue(key, value);
      if (verdict.ok) out[key] = value as never;
    } // 未知键/坏值静默丢弃（文件面历史事实不崩命令面）
  }
  // 自定义档位可达性（对抗审查 #13）：defaultMode 指向同文件 permission.profiles 内的
  // 合法行时接受（值域 = 内置 ∪ 本文件自定义行；拼错 id 仍被丢弃——fail-closed）
  const mode = out["permission.defaultMode"];
  if (mode === undefined && typeof parsed["permission.defaultMode"] === "string") {
    const profiles = Array.isArray(parsed["permission.profiles"]) ? (parsed["permission.profiles"] as unknown[]) : [];
    const hit = profiles.some((row) => typeof row === "object" && row !== null && (row as { id?: unknown }).id === parsed["permission.defaultMode"] && profileRowValid(row));
    if (hit) out["permission.defaultMode"] = parsed["permission.defaultMode"] as never;
  }
  return out;
}

/** 用户级读口（<agentDir>/hub-settings.json） */
export function readHubSettings(agentDir: string): Promise<HubSettings> {
  return readSettingsFile(userSettingsPath(agentDir));
}

export function userSettingsPath(agentDir: string): string {
  return join(agentDir, "hub-settings.json");
}

/** 项目级设置文件路径（projectSettingsPath 单源） */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_DATA_DIR, "hub-settings.json");
}

/** 项目级读口（<cwd>/.x-harness/hub-settings.json） */
export function readProjectSettings(cwd: string): Promise<HubSettings> {
  return readSettingsFile(projectSettingsPath(cwd));
}

/** 用户级写口（目录恒在——ensureAgentDir） */
export function writeHubSettings(agentDir: string, next: HubSettings): Promise<void> {
  return atomicWriteJson(userSettingsPath(agentDir), next);
}

/** cwd 规范化（DESIGN §3.9：realpath 成功用 realpath；失败降级
 *  resolve + 去尾斜杠——比对双边统一走本函数） */
export async function normalizeCwd(raw: string): Promise<string> {
  const trimmed = raw.endsWith("/") && raw !== "/" ? raw.slice(0, -1) : raw;
  const real = await realpath(trimmed).catch(() => undefined);
  return real ?? resolve(trimmed);
}

/** 路径级串行读改写（atomic-file 单点——分链/回收/原子写全在彼处） */
export function updateSettingsFile(path: string, mutate: (current: HubSettings) => HubSettings | Promise<HubSettings>): Promise<HubSettings> {
  return updateJson<HubSettings>(path, {
    read: () => readSettingsFile(path),
    write: (next) => atomicWriteJson(path, next),
    mutate,
  });
}

/** 用户级串行写口 */
export function updateHubSettings(agentDir: string, mutate: (current: HubSettings) => HubSettings | Promise<HubSettings>): Promise<HubSettings> {
  return updateSettingsFile(userSettingsPath(agentDir), mutate);
}

/** 写链活跃路径数（测试口径：回收有界性断言——atomic-file 单点委托） */
export function activeSettingPaths(): number {
  return activeAtomicPaths();
}

/** 合并视图（覆盖型键项目胜 / 名单键并集 / 规则档位并集同键去重项目胜）+ 每键来源（DESIGN §3.9） */
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
  const unionKeys: Array<keyof HubSettings> = ["skills.disabled", "plugins.disabled"];
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

/** 通用并集落位：非空才写值与来源标记 */
function mergeInto<T>(target: { values: HubSettings; sources: Record<string, "project" | "user" | "union"> }, key: keyof HubSettings, merged: readonly T[]): void {
  if (merged.length === 0) return;
  (target.values[key] as unknown) = merged;
  target.sources[key as string] = "union";
}

/** 规则条目并集：同 (tool,pattern) 项目压用户（后写覆盖） */
function mergeRuleEntries(user: HubSettings, project: HubSettings): readonly RuleEntry[] {
  const byKey = new Map<string, RuleEntry>();
  for (const entry of [...(user["permission.rules"] ?? []), ...(project["permission.rules"] ?? [])]) {
    const key = `${entry.tool}\u0000${entry.pattern}`;
    const existing = byKey.get(key);
    // 同键冲突 deny 胜（§9.2 deny 跨作用域压过一切——合并层不得物理删除 deny）
    if (existing !== undefined && existing.verdict === "deny") continue;
    if (existing !== undefined && entry.verdict === "deny") {
      byKey.set(key, entry);
      continue;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => `${a.tool}:${a.pattern}`.localeCompare(`${b.tool}:${b.pattern}`));
}

/** 自定义档位并集：同 id 项目压用户 */
function mergeProfileRows(user: HubSettings, project: HubSettings): readonly PermissionProfile[] {
  const byId = new Map<string, PermissionProfile>();
  for (const row of [...(user["permission.profiles"] ?? []), ...(project["permission.profiles"] ?? [])]) {
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
