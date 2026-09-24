// 用户 agents 类型根一次性迁移回归（agentDir 派生缝的存量数据腿，与
// skills-migrate 同构）：搬运/同名跳过/哨兵幂等/旧根不删/根同路径短路/旧根缺席
// 静默/env 关闭缝。oldRoot 注入缝驱动（沙箱隔离）。
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateAgentTypeRoot, migrateLegacyAgentTypes } from "../host/agents-migrate.ts";
import { userAgentsDirOf } from "@x-harness/agent-delegation";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function seedType(root: string, name: string, description = "d"): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}`);
}

describe("migrateAgentTypeRoot（搬运基元）", () => {
  it("逐类型 .md 搬入；非 .md/子目录跳过；旧根原样保留", async () => {
    const oldRoot = await tempRoot("amig-old-");
    const newRoot = await tempRoot("amig-new-");
    await seedType(oldRoot, "alpha");
    await seedType(oldRoot, "beta");
    await writeFile(join(oldRoot, "notes.txt"), "not an agent type");
    await mkdir(join(oldRoot, "subdir"), { recursive: true });

    const { moved, skipped } = await migrateAgentTypeRoot(oldRoot, newRoot);
    expect(moved.sort()).toEqual(["alpha.md", "beta.md"]);
    expect(skipped).toEqual([]);
    expect(await readFile(join(newRoot, "alpha.md"), "utf8")).toContain("alpha");
    // 旧根不删（CLI 共享目录永不动删）——包括 notes.txt/subdir 全保留
    expect((await readdir(oldRoot)).sort()).toEqual(["alpha.md", "beta.md", "notes.txt", "subdir"]);
  });

  it("新根同名跳过（新根优先不覆盖）", async () => {
    const oldRoot = await tempRoot("amig-old2-");
    const newRoot = await tempRoot("amig-new2-");
    await seedType(oldRoot, "shared", "old version");
    await seedType(oldRoot, "fresh");
    await seedType(newRoot, "shared", "new version");

    const { moved, skipped } = await migrateAgentTypeRoot(oldRoot, newRoot);
    expect(moved).toEqual(["fresh.md"]);
    expect(skipped).toEqual(["shared.md"]);
    expect(await readFile(join(newRoot, "shared.md"), "utf8")).toContain("new version");
  });

  it("旧根不可读/缺席：空结果不抛", async () => {
    const result = await migrateAgentTypeRoot(join(await tempRoot("amig-none-"), "ghost"), await tempRoot("amig-n2-"));
    expect(result).toEqual({ moved: [], skipped: [] });
  });
});

describe("migrateLegacyAgentTypes（启动序一次性质）", () => {
  it("旧根在场：搬入 <agentDir>/agents + 哨兵落盘；二次调用零动作", async () => {
    const oldRoot = await tempRoot("amig-old3-");
    const agentDir = await tempRoot("amig-agent-");
    await seedType(oldRoot, "alpha");

    await migrateLegacyAgentTypes(agentDir, oldRoot);
    const newRoot = userAgentsDirOf(undefined, agentDir);
    expect(newRoot).toBe(join(agentDir, "agents"));
    expect(await readFile(join(newRoot, "alpha.md"), "utf8")).toContain("alpha");
    expect(await readFile(join(agentDir, ".agents-migrated"), "utf8")).toContain(`migrated from ${oldRoot}`);

    // 幂等：哨兵在场，再种旧根新类型也不搬
    await seedType(oldRoot, "late-arrival");
    await migrateLegacyAgentTypes(agentDir, oldRoot);
    expect(await readdir(newRoot)).toEqual(["alpha.md"]);
  });

  it("旧根缺席：仅落哨兵（一次性语义由哨兵封口）", async () => {
    const oldRoot = await tempRoot("amig-empty-");
    const agentDir = await tempRoot("amig-agent2-");
    await migrateLegacyAgentTypes(agentDir, oldRoot);
    expect(await readFile(join(agentDir, ".agents-migrated"), "utf8")).toContain("migrated from");
    expect(await readdir(join(agentDir, "agents")).catch(() => [])).toEqual([]);
  });

  it("根同路径（oldRoot 恰等于新根——防自拷贝短路）：零搬运 + 哨兵标记", async () => {
    const agentDir = await tempRoot("amig-agent4-");
    const newRoot = userAgentsDirOf(undefined, agentDir);
    await seedType(newRoot, "self");
    await migrateLegacyAgentTypes(agentDir, newRoot); // override = 新根本身
    expect(await readFile(join(agentDir, ".agents-migrated"), "utf8")).toContain("roots identical");
    expect(await readdir(newRoot)).toEqual(["self.md"]); // 无自拷贝副产物
  });

  it("env 关闭缝：HUB_AGENTS_MIGRATION=0 跳过（不落哨兵）", async () => {
    const oldRoot = await tempRoot("amig-old5-");
    const agentDir = await tempRoot("amig-agent5-");
    await seedType(oldRoot, "alpha");
    await migrateLegacyAgentTypes(agentDir, oldRoot, { HUB_AGENTS_MIGRATION: "0" });
    expect(await readdir(join(agentDir, "agents")).catch(() => [])).toEqual([]);
    expect(await readFile(join(agentDir, ".agents-migrated"), "utf8").catch(() => "")).toBe("");
  });
});
