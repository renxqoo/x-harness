import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { Operation } from "./types";
import { openFile, missing } from "./open-file";
import { syncPath } from "./sync-path";

export async function cleanPending(op: Operation): Promise<void> {
  const path = join(op.root, "pending.jsonl");

  try {
    const handle = await openFile(op.io, path);
    await handle.close();
    await op.io.unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export async function publishFile(
  op: Operation,
  target: string,
  write: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const pending = join(op.root, "pending.jsonl");
  await cleanPending(op);
  const handle = await openFile(op.io, pending, true);

  try {
    await write(handle);
    op.check();
    await handle.sync();
    op.check();
    op.durable = true;
    await op.io.rename(pending, target);
    await syncPath(op, target);
  } finally {
    op.durable = false;
    await handle.close();
  }
}
