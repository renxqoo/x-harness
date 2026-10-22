import type { Node, Runtime } from "./types";

function ready(runtime: Runtime, node: Node) {
  if (node.blockedRevision === runtime.revision) return false;

  if (node.prepared) {
    const status = node.prepared.status();

    if (!status.ok || status.value !== "ready") return false;
  }

  return (
    !node.batch.stopped &&
    node.batch.active < node.batch.input.concurrency &&
    (runtime.toolActive.get(node.spec.name) ?? 0) < node.capacity &&
    node.parents.every(
      (parent) => parent.actualDone && parent.result?.ok && !parent.result.value.isError,
    )
  );
}

export function selectNode(runtime: Runtime): Node | undefined {
  for (const lane of runtime.lanes) {
    const eligible = runtime.queue.filter(
      (node) => node.batch.lane === lane && ready(runtime, node),
    );

    if (!eligible.length) continue;

    const streak = runtime.streak.get(lane) ?? 0;
    return streak >= 3
      ? eligible[0]!
      : eligible.reduce((best, n) =>
          (n.spec.priority ?? 0) > (best.spec.priority ?? 0) ? n : best,
        );
  }

  return undefined;
}
