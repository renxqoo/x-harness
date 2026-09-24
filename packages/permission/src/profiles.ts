// 档位表（docs/PERMISSION-V2-DESIGN.md §4）：出厂五行数据 + 自定义行合并校验——
// 加档=加行，内核零分支面。id 保留名：内置五档不可被自定义行 shadow（重名拒）。

import type { PermissionProfile } from "./types.ts";
import { PROFILE_IDS } from "./types.ts";

/** 出厂档位（§4.1 表的单一真相） */
export const BUILTIN_PROFILES: readonly PermissionProfile[] = [
  { id: "plan", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" },
  { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "edit-confirm", askPolicy: "on-opaque", containment: "none", mutationPolicy: "confirm-all" },
  { id: "full", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" },
  { id: "sandboxed-auto", askPolicy: "on-failure", containment: "fenced", mutationPolicy: "auto-in-root" },
];

const ASK_POLICIES: readonly PermissionProfile["askPolicy"][] = ["never", "on-failure", "on-opaque", "always"];
const CONTAINMENTS: readonly PermissionProfile["containment"][] = ["none", "fenced"];
const MUTATION_POLICIES: readonly PermissionProfile["mutationPolicy"][] = ["plan-deny", "confirm-all", "auto-in-root"];
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** 单行形态校验（设置文件与命令面同判定——fail-closed） */
export function profileRowValid(row: unknown): row is PermissionProfile {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    ID_SHAPE.test(r["id"]) &&
    ASK_POLICIES.includes(r["askPolicy"] as PermissionProfile["askPolicy"]) &&
    CONTAINMENTS.includes(r["containment"] as PermissionProfile["containment"]) &&
    MUTATION_POLICIES.includes(r["mutationPolicy"] as PermissionProfile["mutationPolicy"])
  );
}

/** 档位解析：内置 > 自定义行；自定义撞内置保留名拒（宿主装载期 fail-fast）。
 *  未知 id 落 auto（垃圾降级不崩溃——安全向中位档，宿主装载层另做显式校验拒写）。 */
export function resolveProfile(id: string, customRows?: readonly PermissionProfile[]): PermissionProfile {
  const builtin = BUILTIN_PROFILES.find((p) => p.id === id);
  if (builtin !== undefined) return builtin;
  if (customRows !== undefined) {
    const custom = customRows.find((p) => p.id === id);
    if (custom !== undefined) return custom;
  }
  return BUILTIN_PROFILES.find((p) => p.id === "auto") as PermissionProfile;
}

/** 自定义行合并校验：形态合法 + 不撞内置保留名 + 行间不重名；坏行拒整批（fail-closed） */
export function mergeCustomProfiles(rows: readonly unknown[]): { ok: true; profiles: readonly PermissionProfile[] } | { ok: false; reason: string } {
  const out: PermissionProfile[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!profileRowValid(row)) return { ok: false, reason: `invalid profile row: ${JSON.stringify(row)}` };
    if ((PROFILE_IDS as readonly string[]).includes(row.id)) return { ok: false, reason: `builtin profile id is reserved: ${row.id}` };
    if (seen.has(row.id)) return { ok: false, reason: `duplicate profile id: ${row.id}` };
    seen.add(row.id);
    out.push(row);
  }
  return { ok: true, profiles: out };
}
