import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const TMP_NAME = /^(?:providers\.json|credentials)\.[0-9]+\.[0-9a-f-]{8,}\.tmp$/;

const TMP_MAX_AGE_MS = 60 * 60 * 1000;

export async function cleanupTmpResidue(agentDir: string): Promise<void> {
  const names = await readdir(agentDir).catch(() => undefined);
  if (names === undefined) return;
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  for (const name of names) {
    if (!TMP_NAME.test(name)) continue;
    const path = join(agentDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    if (info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
  }
  const trash = join(agentDir, "trash");
  const trashed = await readdir(trash).catch(() => undefined);
  if (trashed === undefined) return;
  for (const name of trashed) {
    const path = join(trash, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
