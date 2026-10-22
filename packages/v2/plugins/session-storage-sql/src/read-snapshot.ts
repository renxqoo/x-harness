import type { Query, NamespaceOptions } from "./types";
import type { StorageKey, StorageSnapshot } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readHead } from "./read-head";
import { readReceipt } from "./read-receipt";
import { readNodes } from "./read-nodes";

export async function readSnapshot(
  query: Query,
  options: NamespaceOptions,
  input: StorageKey & { commitId?: string; projection?: boolean },
): Promise<SessionResult<StorageSnapshot>> {
  const head = await readHead(query, options.namespace, input.id);

  if (!head.ok) return head;

  if (input.commitId !== undefined) {
    const commit = await readReceipt(query, { ...input, commitId: input.commitId });

    if (commit.ok)
      return { ok: true, value: Object.freeze({ head: head.value, commit: commit.value }) };

    if (commit.error.source !== "session" || commit.error.code !== "not-found") return commit;
  }

  if (!input.projection) return { ok: true, value: Object.freeze({ head: head.value }) };

  const nodes = await readNodes(query, {
    namespace: options.namespace,
    id: input.id,
    maximum: options.limits.maxConversationNodes,
    revision: head.value.revision,
  });
  return nodes.ok
    ? { ok: true, value: Object.freeze({ head: head.value, nodes: nodes.value }) }
    : nodes;
}
