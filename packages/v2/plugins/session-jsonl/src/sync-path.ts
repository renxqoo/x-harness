import { dirname } from "node:path";
import { constants } from "node:fs";
import type { Operation } from "./types";
export async function syncPath(op: Operation, path: string): Promise<void> {
  let current = dirname(path);
  for (;;) { const handle = await op.io.open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } const parent = dirname(current); if (parent === current) break; current = parent; }
}
