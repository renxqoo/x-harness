// 用户技能根一次性迁移（agentDir 派生缝的存量数据腿）：旧根 ~/.x-harness/skills
// 存在且新根 <agentDir>/skills 尚无同名技能时搬运目录树。幂等：哨兵文件
// <agentDir>/.skills-migrated 落盘后永不再跑（升级一次即收敛）；冲突策略 =
// 逐技能「新根同名跳过」（新根优先——用户可能已在新根重装更新版本），跳过项
// 不删旧根源（旧根是 CLI 共享目录，非本 hub 私产，永不动删）。
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { userSkillsDirOf } from "@x-harness/skill";

const SENTINEL = ".skills-migrated";

/** 哨兵在场 = 已迁移（或显式标记跳过）——幂等门。 */
async function alreadyMigrated(agentDir: string): Promise<boolean> {
  return (await stat(join(agentDir, SENTINEL)).catch(() => undefined)) !== undefined;
}

/** 旧根逐技能搬入新根；返回 {moved, skipped}（诊断日志用）。同名跳过不覆盖。
 *  旧根不可读 = 无迁移面（非错误，静默收哨兵）。 */
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
    if (entry.name.startsWith(".")) continue; // 隐藏文件/暂存不是技能
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(oldRoot, entry.name);
    const target = join(newRoot, entry.name);
    if ((await stat(target).catch(() => undefined)) !== undefined) {
      skipped.push(entry.name); // 新根同名：新根优先，不覆盖不删源
      continue;
    }
    try {
      await cp(source, target, { recursive: true, force: false, verbatimSymlinks: true });
      moved.push(entry.name);
    } catch {
      skipped.push(entry.name); // 单技能失败不阻断其余（哨兵后不再重试——
      // 用户可经 skills/install 手工补；宁可少搬不可挂启动）
    }
  }
  return { moved, skipped };
}

/** host 启动序调用（一次性质）：agentDir 派生根在场（打包发行态）且未迁移时执行。
 *  oldRoot 注入缝：缺省 ~/.x-harness/skills（HOME 派生）；测试隔离传入沙箱根。
 *  env 关闭缝：HUB_SKILLS_MIGRATION=0 跳过（测试宿主防真实旧根泄漏进沙箱 agentDir）。
 *  任何失败只告警不挂启动。 */
export async function migrateLegacySkills(agentDir: string, oldRootOverride?: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (agentDir === "") return;
  if (env["HUB_SKILLS_MIGRATION"] === "0") return;
  if (await alreadyMigrated(agentDir)) return;
  const oldRoot = oldRootOverride ?? userSkillsDirOf(); // ~/.x-harness/skills
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
