import type { PermissionProfile } from "./types.ts";

const ASK_POLICIES: readonly PermissionProfile["askPolicy"][] = ["never", "on-failure", "on-opaque", "always"];
const CONTAINMENTS: readonly PermissionProfile["containment"][] = ["none", "fenced"];
const MUTATION_POLICIES: readonly PermissionProfile["mutationPolicy"][] = ["plan-deny", "confirm-all", "auto-in-root"];
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9-]*$/;

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
  const neverAsk = r["askPolicy"] === "never";
  const tightening = r["mutationPolicy"] === "plan-deny" || r["mutationPolicy"] === "confirm-all";
  return !(neverAsk && tightening);
}
