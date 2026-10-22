import type { PlannedPlugin } from "./types";

export function samePlugin(left: PlannedPlugin, right: PlannedPlugin): boolean {
  if (left.source !== right.source || left.spec.setup !== right.spec.setup) return false;

  return (["requires", "optional", "provides"] as const).every((field) => {
    const a = left.spec[field]!;
    const b = right.spec[field]!;
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => a[key] === b[key])
    );
  });
}
