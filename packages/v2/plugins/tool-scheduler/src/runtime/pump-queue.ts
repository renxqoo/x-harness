import type { Runtime } from "./types";
import { selectNode } from "./select-node";
import { startNode } from "./start-node";
import { fail } from "../domain/fail";
import { recordResult } from "./record-result";
import { releaseNode } from "./release-node";
import { completeBatch } from "./complete-batch";

export function pumpQueue(runtime: Runtime) {
  if (runtime.pumping || runtime.closed) return;

  runtime.pumping = true;

  try {
    let blocked = true;

    while (blocked) {
      blocked = false;

      for (const node of runtime.queue.slice()) {
        if (node.state !== "pending" || node.batch.stopped) continue;

        if (node.prepared) {
          const status = node.prepared.status();

          if (!status.ok) {
            node.prepared = undefined;
            node.commit = undefined;

            if (status.error.source === "tools" && status.error.code === "stale-plan") continue;

            runtime.queue.splice(runtime.queue.indexOf(node), 1);
            node.state = "done";
            node.actualDone = true;
            recordResult(runtime, node, status);
            releaseNode(runtime, node);
            completeBatch(node.batch);
            blocked = true;
            continue;
          }
        }

        if (
          node.parents.some((parent) => {
            const result = parent.result;
            return result && (!result.ok || result.value.isError);
          })
        ) {
          runtime.queue.splice(runtime.queue.indexOf(node), 1);
          node.state = "done";
          node.actualDone = true;
          recordResult(runtime, node, fail("dependency-failed"));
          releaseNode(runtime, node);
          completeBatch(node.batch);
          blocked = true;
        }
      }
    }

    while (
      runtime.running + runtime.committing < runtime.limits.concurrency &&
      runtime.checking < 32
    ) {
      const node = selectNode(runtime);

      if (!node) break;

      runtime.queue.splice(runtime.queue.indexOf(node), 1);
      startNode(runtime, node);
    }

    for (const batch of runtime.batches) completeBatch(batch);

    if (!runtime.queue.length && !runtime.checking && !runtime.committing) {
      runtime.lanes.length = 0;
      runtime.streak.clear();
    }
  } finally {
    runtime.pumping = false;
  }
}
