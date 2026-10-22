import { join } from "node:path";
import { encodeId, decodeId } from "./encode-id";
import { stop } from "./fail";

export function namespacePath(root: string, namespace: string): string {
  return join(root, "namespaces", encodeId(namespace));
}

export function sessionPath(root: string, key: { namespace: string; id: string }): string {
  return join(namespacePath(root, key.namespace), "sessions", `${encodeId(key.id)}.jsonl`);
}

export function sessionId(filename: string): string {
  if (!filename.endsWith(".jsonl")) stop("storage-corrupt");

  return decodeId(filename.slice(0, -6));
}
