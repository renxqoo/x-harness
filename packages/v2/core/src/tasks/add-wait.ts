import type { Result } from "../contracts/types";
import type { Runtime } from "../runtime/types";

export function addWait(runtime: Runtime, source: string, target: string): Result<() => void> {
  const pending = [target];
  const seen = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if (node === source) return runtime.fault("wait-cycle");
    if (seen.has(node)) continue;
    seen.add(node);
    pending.push(...(runtime.waiting.get(node)?.keys() ?? []));
  }
  const edges = runtime.waiting.get(source) ?? new Map<string, number>();
  edges.set(target, (edges.get(target) ?? 0) + 1);
  runtime.waiting.set(source, edges);
  return { ok: true, value: () => {
    const remaining = (edges.get(target) ?? 1) - 1;
    if (remaining) edges.set(target, remaining);
    else edges.delete(target);
    if (!edges.size) runtime.waiting.delete(source);
  } };
}
