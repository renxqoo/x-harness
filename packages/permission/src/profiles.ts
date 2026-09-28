// 档位校验（V4 #7a 净化后剩余面）：行形态校验归 base（宿主 settings/命令面消费——
// 机制）；内置行数据与解析归 @x-harness/permission-modes（模式知识）。

import type { PermissionProfile } from "./types.ts";

const ASK_POLICIES: readonly PermissionProfile["askPolicy"][] = ["never", "on-failure", "on-opaque", "always"];
const CONTAINMENTS: readonly PermissionProfile["containment"][] = ["none", "fenced"];
const MUTATION_POLICIES: readonly PermissionProfile["mutationPolicy"][] = ["plan-deny", "confirm-all", "auto-in-root"];
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** 单行形态校验（设置文件与命令面同判定——fail-closed） */
export function profileRowValid(row: unknown): row is PermissionProfile {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (
    !(
      typeof r["id"] === "string" &&
      ID_SHAPE.test(r["id"]) &&
      ASK_POLICIES.includes(r["askPolicy"] as PermissionProfile["askPolicy"]) &&
      CONTAINMENTS.includes(r["containment"] as PermissionProfile["containment"]) &&
      MUTATION_POLICIES.includes(r["mutationPolicy"] as PermissionProfile["mutationPolicy"])
    )
  ) {
    return false;
  }
  // P1-2（2026-09-28）：矛盾组合拒收——「从不问」吞收紧策略的行映射期即反转到最宽档
  const neverAsk = r["askPolicy"] === "never";
  const tightening = r["mutationPolicy"] === "plan-deny" || r["mutationPolicy"] === "confirm-all";
  return !(neverAsk && tightening);
}
