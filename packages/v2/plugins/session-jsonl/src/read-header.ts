import { isStorageCount } from "../../session/src/storage";
import type { StoragePolicy } from "../../session/src/storage";
import { digest, payload } from "./encode-line";
import { readHead } from "./read-values";
import { stop } from "./fail";

export function readJournalHeader(
  parsed: Record<string, unknown>,
  input: { namespace: string; id: string; policy: StoragePolicy },
) {
  const header = payload(parsed);

  if (
    parsed.checksum !== digest(JSON.stringify(header)) ||
    Object.keys(header).join(",") !== "kind,namespace,head,mode,receipts" ||
    header.kind !== "header" ||
    header.namespace !== input.namespace ||
    !["empty", "fork", "snapshot"].includes(header.mode as string) ||
    !isStorageCount(header.receipts) ||
    header.receipts > input.policy.maxRecords
  )
    stop("storage-corrupt");

  const head = readHead(header.head, input.id, input.policy);
  const mode = header.mode as "empty" | "fork" | "snapshot";
  const receipts = header.receipts;

  if (
    (mode === "empty" && (head.revision !== 0 || head.bytes !== 0 || head.parent || receipts)) ||
    (mode === "fork" && (!head.parent || head.parent.revision !== head.revision || receipts))
  )
    stop("storage-corrupt");

  return { head, mode, receipts, checksum: parsed.checksum as string };
}
