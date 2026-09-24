// skills/inspect + skills/install 单测（docs/SKILL-INSTALL.md §7）：候选三态与问题码、
// 名围栏、拷贝语义（含 symlink 跳过）、覆盖与回滚、限额、生效目录集门禁、写后复检。
// 隔离靠 homeDir 注入（user 技能根）+ 临时源树；限额注入让小限额可测。

import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "@x-harness/skill";
import { inspectSkillSources, installSkill } from "../host/skills-install.ts";
import type { SkillImportLimits } from "../host/skills-install.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const LIMITS: SkillImportLimits = { maxBytes: 1024 * 1024, maxEntries: 64 };

/** 造一个技能目录并返回其路径；frontmatter 为 null 表示不写 SKILL.md */
async function makeSkill(base: string, dirName: string, frontmatter: string | null): Promise<string> {
  const dir = join(base, dirName);
  await mkdir(dir, { recursive: true });
  if (frontmatter !== null) await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`, "utf8");
  return dir;
}

const ORIGINAL_DIRS = process.env["X_HARNESS_SKILLS_DIRS"];
afterEach(() => {
  if (ORIGINAL_DIRS === undefined) delete process.env["X_HARNESS_SKILLS_DIRS"];
  else process.env["X_HARNESS_SKILLS_DIRS"] = ORIGINAL_DIRS;
});

describe("inspectSkillSources", () => {
  it("三态混合：ready（声明名 = 目录名）/ rename（声明名 ≠ 目录名）/ blocked（问题码），按入参序", async () => {
    const src = await tempDir("xh-src-");
    const ready = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    const rename = await makeSkill(src, "tavily", "name: tavily-cli\ndescription: CLI");
    const blocked = await makeSkill(src, "broken", "description: 缺 name");
    const outcome = await inspectSkillSources({ sourcePaths: [rename, blocked, ready, ready] });
    expect(outcome).toEqual({
      ok: true,
      results: [
        { sourcePath: rename, state: "rename", name: "tavily-cli", description: "CLI" },
        { sourcePath: blocked, state: "blocked", problem: "missing_fields" },
        { sourcePath: ready, state: "ready", name: "alpha", description: "A" },
        { sourcePath: ready, state: "ready", name: "alpha", description: "A" },
      ],
    });
  });

  it.each([
    ["SKILL.md 缺席", "ghost", "not_found"],
    ["无 frontmatter", "nofm", "no_frontmatter"],
  ])("blocked 问题码：%s", async (_label, dirName, problem) => {
    const src = await tempDir("xh-src-");
    const dir = join(src, dirName);
    await mkdir(dir, { recursive: true });
    if (dirName === "nofm") await writeFile(join(dir, "SKILL.md"), "no frontmatter", "utf8");
    expect(await inspectSkillSources({ sourcePaths: [dir] })).toEqual({ ok: true, results: [{ sourcePath: dir, state: "blocked", problem }] });
  });

  it.each([
    ["非数组", "not-an-array"],
    ["空数组", []],
    ["超批上限（201 条）", Array.from({ length: 201 }, (_v, i) => `/p/${i}`)],
    ["相对路径元素", ["relative/path"]],
    ["非字符串元素", [42]],
    ["含换行元素", ["/p/x\ny"]],
  ])("入参形态非法 → invalid_input：%s", async (_label, sourcePaths) => {
    const outcome = await inspectSkillSources({ sourcePaths });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("invalid sourcePaths");
  });
});

describe("installSkill", () => {
  it("全树拷贝（含嵌套目录与捆绑文件）：name/path/skippedEntries + 源目录不动 + 装载器可见", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await writeFile(join(from, "helper.sh"), "echo hi\n", "utf8");
    await mkdir(join(from, "references"), { recursive: true });
    await writeFile(join(from, "references", "guide.md"), "# guide\n", "utf8");
    const root = join(home, ".x-harness", "skills");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome).toEqual({ ok: true, skill: { name: "alpha", path: join(root, "alpha", "SKILL.md"), skippedEntries: 0 } });
    expect(await readFile(join(root, "alpha", "references", "guide.md"), "utf8")).toBe("# guide\n");
    expect((await stat(from)).isDirectory()).toBe(true); // 源不动（复制而非移动）
    expect(await loadSkills([root])).toEqual({ skills: { alpha: { name: "alpha", description: "A", path: join(root, "alpha", "SKILL.md") } }, warnings: [] });
    // 暂存与备份不留残迹
    expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
  });

  it("声明名 ≠ 目录名（rename 档）：目标目录名 = 声明名，无需改写", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "tavily", "name: tavily-cli\ndescription: CLI");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome.ok && outcome.skill.name).toBe("tavily-cli");
    expect((await stat(join(home, ".x-harness", "skills", "tavily-cli", "SKILL.md"))).isFile()).toBe(true);
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toContain("name: tavily-cli"); // 源不动
  });

  it("显式 name 覆盖：只改写副本的 name 行（源文件与其余字段字节不变）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "tavily", "name: tavily-cli\ndescription: CLI\nextra: keep");
    const outcome = await installSkill({ sourcePath: from, name: "tavily-local", homeDir: home, limits: LIMITS });
    expect(outcome.ok && outcome.skill.name).toBe("tavily-local");
    const text = await readFile(join(home, ".x-harness", "skills", "tavily-local", "SKILL.md"), "utf8");
    expect(text).toBe("---\nname: tavily-local\ndescription: CLI\nextra: keep\n---\nbody\n");
    expect(await readFile(join(from, "SKILL.md"), "utf8")).toBe("---\nname: tavily-cli\ndescription: CLI\nextra: keep\n---\nbody\n");
    const loaded = await loadSkills([join(home, ".x-harness", "skills")]);
    expect(loaded.skills["tavily-local"]?.description).toBe("CLI");
  });

  it.each([
    ["空串", ""],
    ["点", "."],
    ["双点", ".."],
    ["含斜杠", "a/b"],
    ["含反斜杠", "a\\b"],
    ["含换行", "a\nb"],
    ["含 NUL", "a\u0000b"],
    ["超长（129）", "a".repeat(129)],
  ])("名围栏：%s → invalid_input（不落盘）", async (_label, name) => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    const outcome = await installSkill({ sourcePath: from, name, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("invalid skill name");
    expect(await stat(join(home, ".x-harness", "skills")).catch(() => undefined)).toBeUndefined(); // 未落盘（拒在写之前）
  });

  it.each([
    ["相对路径", "relative/path"],
    ["非字符串", 42],
    ["undefined", undefined],
  ])("源路径非法 → invalid_input：%s", async (_label, sourcePath) => {
    const home = await tempDir("xh-home-");
    const outcome = await installSkill({ sourcePath, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("invalid skill source");
  });

  it("源不是可装载技能 → invalid_input（含问题码）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const dir = join(src, "broken");
    await mkdir(dir, { recursive: true });
    const outcome = await installSkill({ sourcePath: dir, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toBe(`invalid skill source: not_found: ${dir}`);
  });

  it("同名已装 + 未 overwrite → name_conflict，既有内容字节未变", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const installed = await makeSkill(join(home, ".x-harness", "skills"), "alpha", "name: alpha\ndescription: OLD");
    await writeFile(join(installed, "old-bundle.txt"), "old\n", "utf8");
    const from = await makeSkill(src, "alpha-src", "name: alpha\ndescription: NEW");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome).toEqual({ ok: false, error: { code: "name_conflict", message: "skill already installed: alpha (pass overwrite: true to replace)" } });
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toContain("description: OLD");
    expect((await stat(join(installed, "old-bundle.txt"))).isFile()).toBe(true);
  });

  it("overwrite 垃圾值（非 true）降级为 false → name_conflict（不静默覆盖）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    await makeSkill(join(home, ".x-harness", "skills"), "alpha", "name: alpha\ndescription: OLD");
    const from = await makeSkill(src, "alpha-src", "name: alpha\ndescription: NEW");
    const outcome = await installSkill({ sourcePath: from, overwrite: "yes", homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("name_conflict");
  });

  it("overwrite：新内容换入、旧捆绑文件不再存在、备份清理干净", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const installed = await makeSkill(join(home, ".x-harness", "skills"), "alpha", "name: alpha\ndescription: OLD");
    await writeFile(join(installed, "old-bundle.txt"), "old\n", "utf8");
    const from = await makeSkill(src, "alpha-src", "name: alpha\ndescription: NEW");
    await writeFile(join(from, "new-bundle.txt"), "new\n", "utf8");
    const outcome = await installSkill({ sourcePath: from, overwrite: true, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(true);
    const target = join(home, ".x-harness", "skills", "alpha");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("description: NEW");
    expect((await stat(join(target, "new-bundle.txt"))).isFile()).toBe(true);
    expect(await stat(join(target, "old-bundle.txt")).catch(() => undefined)).toBeUndefined();
    expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
  });

  it("自装自：源就是目标（realpath 同判）→ invalid_input", async () => {
    const home = await tempDir("xh-home-");
    const installed = await makeSkill(join(home, ".x-harness", "skills"), "alpha", "name: alpha\ndescription: A");
    const outcome = await installSkill({ sourcePath: installed, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("already the install target");
  });

  it("源内 symlink 条目：不复制不跟随、计数回显（防技能根外文件以链接形态进入技能目录）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const secret = await tempDir("xh-secret-");
    await writeFile(join(secret, "id_rsa"), "SECRET", "utf8");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await symlink(join(secret, "id_rsa"), join(from, "leak"));
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome.ok && outcome.skill.skippedEntries).toBe(1);
    expect(await stat(join(home, ".x-harness", "skills", "alpha", "leak")).catch(() => undefined)).toBeUndefined();
  });

  it("源目录本身是 symlink：跟随复制其内容（装载器既有语义），链接不动", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const real = await makeSkill(src, "real", "name: linked\ndescription: L");
    await symlink(real, join(src, "linked"));
    const outcome = await installSkill({ sourcePath: join(src, "linked"), homeDir: home, limits: LIMITS });
    expect(outcome.ok && outcome.skill.name).toBe("linked");
    const target = join(home, ".x-harness", "skills", "linked");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect((await stat(target)).isSymbolicLink()).toBe(false);
    expect((await lstat(join(src, "linked"))).isSymbolicLink()).toBe(true);
  });

  it("拷贝字节超限额 → invalid_input + 回滚（目标无残迹）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await writeFile(join(from, "big.bin"), "x".repeat(2048), "utf8");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: { maxBytes: 1024, maxEntries: 64 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("too large");
    expect(await stat(join(home, ".x-harness", "skills", "alpha")).catch(() => undefined)).toBeUndefined();
    expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
  });

  it("拷贝条目数超限额 → invalid_input + 回滚", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await writeFile(join(from, "a.txt"), "a", "utf8");
    await writeFile(join(from, "b.txt"), "b", "utf8");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: { maxBytes: 1024 * 1024, maxEntries: 1 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_input");
    expect(outcome.error.message).toContain("entries");
    expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
  });

  it("装载器侧用户技能根不在生效技能目录集（X_HARNESS_SKILLS_DIRS 覆盖）→ state_conflict（不静默装成看不见的）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    process.env["X_HARNESS_SKILLS_DIRS"] = join(home, "elsewhere");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("state_conflict");
    expect(outcome.error.message).toContain("not an effective skill directory");
    expect(await stat(join(home, ".x-harness", "skills")).catch(() => undefined)).toBeUndefined();
    // 生效目录集含装载器侧用户根 → 放行
    process.env["X_HARNESS_SKILLS_DIRS"] = `${join(home, "elsewhere")}:${join(homedir(), ".x-harness", "skills")}`;
    expect((await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS })).ok).toBe(true);
  });

  // root 运行时 chmod 不产生 EACCES——权限用例仅在非 root 生效
  it.skipIf(process.getuid?.() === 0)("换入失败（技能根只读）→ io_failed + 暂存清理（不改变既有状态）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    const root = join(home, ".x-harness", "skills");
    await mkdir(root, { recursive: true });
    await chmod(root, 0o555);
    try {
      const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("io_failed");
      expect(await readdir(root)).toEqual([]);
      expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
    } finally {
      await chmod(root, 0o755);
    }
  });

  // root 运行时 chmod 不产生 EACCES——权限用例仅在非 root 生效
  it.skipIf(process.getuid?.() === 0)("嵌套子树内文件不可读 → io_failed + 整树回滚（拷贝失败向上传播）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await mkdir(join(from, "references"), { recursive: true });
    await writeFile(join(from, "references", "locked.md"), "# locked\n", "utf8");
    await chmod(join(from, "references", "locked.md"), 0o000);
    try {
      const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("io_failed");
      expect(await stat(join(home, ".x-harness", "skills", "alpha")).catch(() => undefined)).toBeUndefined();
      expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]); // 暂存整树回收
    } finally {
      await chmod(join(from, "references", "locked.md"), 0o644);
    }
  });

  it.skipIf(process.getuid?.() === 0)("暂存目录不可建（.x-harness 只读）→ io_failed，技能根无新内容", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    const base = join(home, ".x-harness");
    await mkdir(join(base, "skills"), { recursive: true });
    await chmod(base, 0o555);
    try {
      const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("io_failed");
      expect(await readdir(join(base, "skills"))).toEqual([]);
    } finally {
      await chmod(base, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)("覆盖路径的备份改名失败（技能根只读）→ io_failed，旧内容原地不动", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const installed = await makeSkill(join(home, ".x-harness", "skills"), "alpha", "name: alpha\ndescription: OLD");
    const from = await makeSkill(src, "alpha-src", "name: alpha\ndescription: NEW");
    const root = join(home, ".x-harness", "skills");
    await chmod(root, 0o555);
    try {
      const outcome = await installSkill({ sourcePath: from, overwrite: true, homeDir: home, limits: LIMITS });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("io_failed");
      expect(await readFile(join(installed, "SKILL.md"), "utf8")).toContain("description: OLD");
      expect(await readdir(join(home, ".x-harness", ".tmp"))).toEqual([]);
    } finally {
      await chmod(root, 0o755);
    }
  });

  it("暂存根被占为 symlink → io_failed，不向链接目标写入任何东西（防暂存逃出技能根外）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const elsewhere = await tempDir("xh-elsewhere-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    const base = join(home, ".x-harness");
    await mkdir(base, { recursive: true });
    await symlink(elsewhere, join(base, ".tmp"));
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("io_failed");
    expect(outcome.error.message).toContain("temp path is not a directory");
    expect(await readdir(elsewhere)).toEqual([]); // 链接目标零写入
    expect(await stat(join(base, "skills")).catch(() => undefined)).toBeUndefined(); // 技能根都未建
  });

  it("技能根父路径被文件占位 → io_failed（不崩、不留暂存）", async () => {
    const home = await tempDir("xh-home-");
    const src = await tempDir("xh-src-");
    const from = await makeSkill(src, "alpha", "name: alpha\ndescription: A");
    await writeFile(join(home, ".x-harness"), "occupied", "utf8");
    const outcome = await installSkill({ sourcePath: from, homeDir: home, limits: LIMITS });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("io_failed");
  });
});
