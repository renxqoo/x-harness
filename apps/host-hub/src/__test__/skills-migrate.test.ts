// 用户技能根一次性迁移回归（agentDir 派生缝的存量数据腿）：搬运/同名跳过/
// 哨兵幂等/旧根不删/根同路径短路/旧根缺席静默。oldRoot 注入缝驱动（沙箱隔离）。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacySkills, migrateSkillRoot } from "../host/skills-migrate.ts";
import { userSkillsDirOf } from "@x-harness/skill";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function seedSkill(root: string, name: string, description = "d"): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
}

describe("migrateSkillRoot（搬运基元）", () => {
  it("逐技能搬入；隐藏项/普通文件跳过；旧根原样保留", async () => {
    const oldRoot = await tempRoot("mig-old-");
    const newRoot = await tempRoot("mig-new-");
    await seedSkill(oldRoot, "alpha");
    await seedSkill(oldRoot, "beta");
    await writeFile(join(oldRoot, "loose.md"), "not a skill dir");
    await mkdir(join(oldRoot, ".staging"), { recursive: true });

    const { moved, skipped } = await migrateSkillRoot(oldRoot, newRoot);
    expect(moved.sort()).toEqual(["alpha", "beta"]);
    expect(skipped).toEqual([]);
    // 新根：技能在场（SKILL.md 随树）
    expect(await readFile(join(newRoot, "alpha", "SKILL.md"), "utf8")).toContain("alpha");
    // 旧根不删（CLI 共享目录永不动删）——包括 loose.md/.staging 全保留
    expect((await readdir(oldRoot)).sort()).toEqual([".staging", "alpha", "beta", "loose.md"]);
  });

  it("新根同名跳过（新根优先不覆盖）；单技能失败不阻断其余", async () => {
    const oldRoot = await tempRoot("mig-old2-");
    const newRoot = await tempRoot("mig-new2-");
    await seedSkill(oldRoot, "shared", "old version");
    await seedSkill(oldRoot, "fresh");
    await seedSkill(newRoot, "shared", "new version");

    const { moved, skipped } = await migrateSkillRoot(oldRoot, newRoot);
    expect(moved).toEqual(["fresh"]);
    expect(skipped).toEqual(["shared"]);
    expect(await readFile(join(newRoot, "shared", "SKILL.md"), "utf8")).toContain("new version");
  });

  it("旧根不可读/缺席：空结果不抛", async () => {
    const result = await migrateSkillRoot(join(await tempRoot("mig-none-"), "ghost"), await tempRoot("mig-n2-"));
    expect(result).toEqual({ moved: [], skipped: [] });
  });
});

describe("migrateLegacySkills（启动序一次性质）", () => {
  it("旧根在场：搬入 <agentDir>/skills + 哨兵落盘；二次调用零动作", async () => {
    const oldRoot = await tempRoot("mig-old3-");
    const agentDir = await tempRoot("mig-agent-");
    await seedSkill(oldRoot, "alpha");

    await migrateLegacySkills(agentDir, oldRoot);
    const newRoot = userSkillsDirOf(undefined, agentDir);
    expect(join(newRoot, "alpha")).toContain(join(agentDir, "skills"));
    expect(await readFile(join(newRoot, "alpha", "SKILL.md"), "utf8")).toContain("alpha");
    expect(await readFile(join(agentDir, ".skills-migrated"), "utf8")).toContain(`migrated from ${oldRoot}`);

    // 幂等：哨兵在场，再种旧根新技能也不搬
    await seedSkill(oldRoot, "late-arrival");
    await migrateLegacySkills(agentDir, oldRoot);
    expect(await readdir(newRoot)).toEqual(["alpha"]);
  });

  it("旧根缺席：仅落哨兵（下次升级旧根出现也不再搬——一次性语义由哨兵封口）", async () => {
    const oldRoot = await tempRoot("mig-empty-");
    const agentDir = await tempRoot("mig-agent2-");
    await migrateLegacySkills(agentDir, oldRoot);
    expect(await readFile(join(agentDir, ".skills-migrated"), "utf8")).toContain("migrated from");
    expect(await readdir(join(agentDir, "skills")).catch(() => [])).toEqual([]);
  });

  it("根同路径（oldRoot 恰等于新根——防自拷贝短路）：零搬运 + 哨兵标记", async () => {
    const agentDir = await tempRoot("mig-agent4-");
    const newRoot = userSkillsDirOf(undefined, agentDir);
    await mkdir(newRoot, { recursive: true });
    await seedSkill(newRoot, "self");
    await migrateLegacySkills(agentDir, newRoot); // override = 新根本身
    expect(await readFile(join(agentDir, ".skills-migrated"), "utf8")).toContain("roots identical");
    expect(await readdir(newRoot)).toEqual(["self"]); // 无自拷贝副产物
  });
});
