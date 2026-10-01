import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { userSkillsDirOf } from "@x-harness/skill";

const SENTINEL = ".skills-migrated";

async function alreadyMigrated(agentDir: string): Promise<boolean> {
  return (await stat(join(agentDir, SENTINEL)).catch(() => undefined)) !== undefined;
}

export async function migrateSkillRoot(oldRoot: string, newRoot: string): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  let entries;
  try {
    entries = await readdir(oldRoot, { withFileTypes: true });
  } catch {
    return { moved, skipped };
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(oldRoot, entry.name);
    const target = join(newRoot, entry.name);
    if ((await stat(target).catch(() => undefined)) !== undefined) {
      skipped.push(entry.name);
      continue;
    }
    try {
      await cp(source, target, { recursive: true, force: false, verbatimSymlinks: true });
      moved.push(entry.name);
    } catch {
      skipped.push(entry.name);
    }
  }
  return { moved, skipped };
}

export async function migrateLegacySkills(agentDir: string, oldRootOverride?: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (agentDir === "") return;
  if (env["HUB_SKILLS_MIGRATION"] === "0") return;
  if (await alreadyMigrated(agentDir)) return;
  const oldRoot = oldRootOverride ?? userSkillsDirOf();
  const newRoot = userSkillsDirOf(undefined, agentDir);
  if (oldRoot === newRoot) {
    await writeFile(join(agentDir, SENTINEL), "roots identical; nothing to do\n", "utf8").catch(() => undefined);
    return;
  }
  const oldExists = (await stat(oldRoot).catch(() => undefined))?.isDirectory() ?? false;
  if (oldExists) {
    await mkdir(newRoot, { recursive: true }).catch(() => undefined);
    const { moved, skipped } = await migrateSkillRoot(oldRoot, newRoot);
    if (moved.length > 0 || skipped.length > 0) {
      process.stderr.write(`hub: skills migrated ${moved.length} from ${oldRoot} (skipped: ${skipped.join(", ") || "none"})\n`);
    }
  }
  await writeFile(join(agentDir, SENTINEL), `migrated from ${oldRoot} at ${new Date().toISOString()}\n`, "utf8").catch(() => undefined);
}
