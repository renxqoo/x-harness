// hub 运行时设置（DESIGN §3.9）：<agentDir>/hub-settings.json（用户级）与
// <cwd>/.x-harness/hub-settings.json（项目级）。host（命令面读写）与 worker（装配期
// 快照读）共享；白名单键校验单点；坏文件降级空表（安全向：permission 回落 auto）；
// 原子写（tmp + rename）；写链按绝对路径分链 + 空闲回收（防泄漏不破串行）。
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModeKnob } from "@x-harness/permission";
import type { ThinkingLevel } from "@x-harness/llm";
import { activeAtomicPaths, atomicWriteJson, updateJson } from "./atomic-file.ts";
import { hubError, type HubErrorShape } from "./errors.ts";
import { hubLog } from "./hub-log.ts";

export interface HubSettings {
  "permission.defaultMode"?: ModeKnob;
  "thinking.default"?: ThinkingLevel;
  "skills.disabled"?: string[];
}

export type HubSettingsKey = keyof HubSettings;

const PERM_MODES: readonly ModeKnob[] = ["plan", "auto", "full"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
/** 项目数据目录名（x-harness 约定：内核 skills/agents 目录同根） */
export const PROJECT_DATA_DIR = ".x-harness";

/** 键白名单 + 值校验（单点——settings/set 的唯一判定面；恒 invalid_input 族） */
export function validateSettingValue(key: string, value: unknown): { ok: true; key: HubSettingsKey } | { ok: false; error: HubErrorShape } {
  if (key === "permission.defaultMode") {
    if (typeof value !== "string" || !PERM_MODES.includes(value as ModeKnob)) {
      return { ok: false, error: hubError("invalid_input", `invalid setting value: permission.defaultMode must be one of ${PERM_MODES.join(", ")}`) };
    }
    return { ok: true, key };
  }
  if (key === "thinking.default") {
    if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
      return { ok: false, error: hubError("invalid_input", `invalid setting value: thinking.default must be one of ${THINKING_LEVELS.join(", ")}`) };
    }
    return { ok: true, key };
  }
  if (key === "skills.disabled") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
      return { ok: false, error: hubError("invalid_input", "invalid setting value: skills.disabled must be an array of non-empty strings") };
    }
    return { ok: true, key };
  }
  return { ok: false, error: hubError("invalid_input", `unknown setting key: ${key}`) };
}

function isKnownKey(key: string): key is HubSettingsKey {
  return key === "permission.defaultMode" || key === "thinking.default" || key === "skills.disabled";
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

/** 合并视图（覆盖型键项目胜 / 名单键并集）+ 每键来源（DESIGN §3.9） */
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
  const union = [...new Set([...(user["skills.disabled"] ?? []), ...(project["skills.disabled"] ?? [])])].sort();
  if (union.length > 0) {
    values["skills.disabled"] = union;
    sources["skills.disabled"] = "union";
  }
  return { values, sources };
}
