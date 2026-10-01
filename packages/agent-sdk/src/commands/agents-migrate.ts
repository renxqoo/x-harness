import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { userAgentsDirOf } from "@x-harness/agent-delegation";

const SENTINEL = ".agents-migrated";

async function alreadyMigrated(agentDir: string): Promise<boolean> {
  return (await stat(join(agentDir, SENTINEL)).catch(() => undefined)) !== undefined;
}

export async function migrateAgentTypeRoot(oldRoot: string, newRoot: string): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  let entries;
  try {
    entries = await readdir(oldRoot, { withFileTypes: true });
  } catch {
    return { moved, skipped };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const source = join(oldRoot, entry.name);
    const target = join(newRoot, entry.name);
    if ((await stat(target).catch(() => undefined)) !== undefined) {
      skipped.push(entry.name);
      continue;
    }
    try {
      await cp(source, target, { force: false });
      moved.push(entry.name);
    } catch {
      skipped.push(entry.name);
    }
  }
  return { moved, skipped };
}

export async function migrateLegacyAgentTypes(agentDir: string, oldRootOverride?: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (agentDir === "") return;
  if (env["HUB_AGENTS_MIGRATION"] === "0") return;
  if (await alreadyMigrated(agentDir)) return;
  const oldRoot = oldRootOverride ?? userAgentsDirOf();
  const newRoot = userAgentsDirOf(undefined, agentDir);
  if (oldRoot === newRoot) {
    await writeFile(join(agentDir, SENTINEL), "roots identical; nothing to do\n", "utf8").catch(() => undefined);
    return;
  }
  const oldExists = (await stat(oldRoot).catch(() => undefined))?.isDirectory() ?? false;
  if (oldExists) {
    await mkdir(newRoot, { recursive: true }).catch(() => undefined);
    const { moved, skipped } = await migrateAgentTypeRoot(oldRoot, newRoot);
    if (moved.length > 0 || skipped.length > 0) {
      process.stderr.write(`hub: agent types migrated ${moved.length} from ${oldRoot} (skipped: ${skipped.join(", ") || "none"})\n`);
    }
  }
  await writeFile(join(agentDir, SENTINEL), `migrated from ${oldRoot} at ${new Date().toISOString()}\n`, "utf8").catch(() => undefined);
}
