import { join } from "node:path";
import type { Operation } from "./types";
import type { StoragePolicy } from "../../session/src/storage";
import { readStoragePolicy } from "../../session/src/storage";
import { directory, openFile, missing } from "./open-file";
import { digest, encodeLine, parseLine, payload } from "./encode-line";
import { publishFile } from "./publish-file";
import { writeLine } from "./write-line";
import { syncPath } from "./sync-path";
import { namespacePath } from "./store-path";
import { stop } from "./fail";

async function readConfig(
  op: Operation,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let file;

  try {
    file = await openFile(op.io, path);
  } catch (error) {
    if (missing(error)) return;

    throw error;
  }

  try {
    if ((await file.stat()).size > 65536) stop("storage-corrupt");

    const raw = await file.readFile();

    if (!raw.length || raw.at(-1) !== 10) stop("storage-corrupt");

    const line = parseLine(raw);
    const data = payload(line);

    if (line.checksum !== digest(JSON.stringify(data))) stop("storage-corrupt");

    await file.sync();
    await syncPath(op, path);
    return data;
  } finally {
    await file.close();
  }
}

export async function initializeRoot(op: Operation): Promise<void> {
  const path = join(op.root, "format.json");
  const format = { kind: "session-jsonl", format: 1, paths: "base32" };
  const stored = await readConfig(op, path);

  if (stored) {
    if (JSON.stringify(stored) !== JSON.stringify(format)) stop("configuration-conflict");
  } else {
    const entries = await op.io.readdir(op.root);

    if (entries.some((entry) => !["store.lock", "pending.jsonl"].includes(entry)))
      stop("configuration-conflict");

    await publishFile(op, path, async (file) => {
      await writeLine(file, encodeLine(format), 0);
    });
  }

  await directory(op.io, join(op.root, "namespaces"), true);
  await syncPath(op, join(op.root, "namespaces/.entry"));
}

export async function readNamespace(
  op: Operation,
  namespace: string,
  requested?: StoragePolicy,
): Promise<StoragePolicy> {
  op.check();
  const root = namespacePath(op.root, namespace);
  const path = join(root, "policy.json");

  try {
    await directory(op.io, root);
  } catch (error) {
    if (!missing(error)) throw error;

    if (!requested) stop("configuration-conflict");

    await directory(op.io, root, true);
  }

  const stored = await readConfig(op, path);
  let policy: StoragePolicy;

  if (stored) {
    const read = readStoragePolicy(stored.policy);

    if (
      stored.namespace !== namespace ||
      Object.keys(stored).join(",") !== "namespace,policy" ||
      !read.ok
    )
      stop("storage-corrupt");

    policy = read.value;

    if (requested && JSON.stringify(policy) !== JSON.stringify(requested))
      stop("configuration-conflict");
  } else {
    if (!requested) stop("configuration-conflict");

    if ((await op.io.readdir(root)).length) stop("storage-corrupt");

    policy = requested;
    await publishFile(op, path, async (file) => {
      await writeLine(file, encodeLine({ namespace, policy }), 0);
    });
  }

  await directory(op.io, join(root, "sessions"), true);
  await syncPath(op, join(root, "sessions/.entry"));
  return policy;
}
