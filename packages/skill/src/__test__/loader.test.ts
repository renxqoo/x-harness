// loader 表驱动（docs/SKILL.md §1.1/§7）：目录解析矩阵 + 注册/拒注册/上限边界。

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, resolveSkillDirs } from "../loader.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一个 skill 目录并返回其路径；frontmatter 传 null 表示不写 SKILL.md */
async function writeSkill(name: string, frontmatter: string | null, body = "instructions"): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (frontmatter !== null) await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe("resolveSkillDirs", () => {
  const ORIGINAL = process.env["X_HARNESS_SKILLS_DIRS"];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["X_HARNESS_SKILLS_DIRS"];
    else process.env["X_HARNESS_SKILLS_DIRS"] = ORIGINAL;
  });

  it("参数优先：原样返回", () => {
    expect(resolveSkillDirs(["/a", "/b"])).toEqual(["/a", "/b"]);
  });

  it("[] = 显式零——不落空回退 env（与 resolveAgentDirs 有意不同）", () => {
    process.env["X_HARNESS_SKILLS_DIRS"] = "/from-env";
    expect(resolveSkillDirs([])).toEqual([]);
  });

  it("env 冒号分隔、空串元素过滤", () => {
    process.env["X_HARNESS_SKILLS_DIRS"] = "/a::/b:";
    expect(resolveSkillDirs()).toEqual(["/a", "/b"]);
  });

  it("env 仅冒号（过滤后空）→ 显式零，不回退缺省", () => {
    process.env["X_HARNESS_SKILLS_DIRS"] = "::";
    expect(resolveSkillDirs()).toEqual([]);
  });

  it("env 空串 → 缺省两目录", () => {
    process.env["X_HARNESS_SKILLS_DIRS"] = "";
    expect(resolveSkillDirs()).toEqual([join(process.cwd(), ".x-harness", "skills"), join(homedir(), ".x-harness", "skills")]);
  });

  it("无参数无 env → 缺省 [cwd 项目域, homedir 用户域]", () => {
    delete process.env["X_HARNESS_SKILLS_DIRS"];
    expect(resolveSkillDirs()).toEqual([join(process.cwd(), ".x-harness", "skills"), join(homedir(), ".x-harness", "skills")]);
  });
});

describe("loadSkills", () => {
  it("合法 skill 注册：path 为 SKILL.md 绝对路径，正文与额外字段不消费", async () => {
    await writeSkill("alpha", "name: alpha\ndescription: does A\nextra: ignored");
    const result = await loadSkills([root]);
    expect(result.warnings).toEqual([]);
    expect(result.skills).toEqual({
      alpha: { name: "alpha", description: "does A", path: join(root, "alpha", "SKILL.md") },
    });
  });

  it("同名双目录：列表序即优先序（前者胜）", async () => {
    const low = await mkdtemp(join(tmpdir(), "xh-skills-low-"));
    const high = await mkdtemp(join(tmpdir(), "xh-skills-high-"));
    try {
      for (const base of [low, high]) {
        await mkdir(join(base, "alpha"), { recursive: true });
        await writeFile(join(base, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: from ${base === high ? "high" : "low"}\n---\n`);
      }
      const result = await loadSkills([high, low]);
      expect(result.skills["alpha"]?.description).toBe("from high");
    } finally {
      await Promise.all([rm(low, { recursive: true, force: true }), rm(high, { recursive: true, force: true })]);
    }
  });

  it.each([
    ["SKILL.md 缺席", "missing", null],
    ["无 frontmatter", "nofm", null],
    ["frontmatter 无冒号行", "broken", "name"],
    ["缺 description", "nodesc", "name: nodesc"],
    ["缺 name", "noname", "description: x"],
    ["name 与目录名不符", "alpha", "name: beta\ndescription: x"],
    ["frontmatter 值非扁平（列表行）", "listy", "name: listy\ndescription: x\n  - item"],
  ])("拒注册 + 告警：%s", async (_label, name, frontmatter) => {
    if (name === "nofm") {
      const dir = join(root, "nofm");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "no frontmatter here");
      const result = await loadSkills([root]);
      expect(result.skills).toEqual({});
      expect(result.warnings).toHaveLength(1);
      return;
    }
    await writeSkill(name, frontmatter);
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings.map((warning) => warning.startsWith("skills: ") && warning.includes(join(root, name, "SKILL.md")))).toContain(true);
  });

  it("告警逐字透传形态判定单点（name 与目录名不符——真实机器常见症状：tavily 声明 tavily-cli）", async () => {
    await writeSkill("tavily", "name: tavily-cli\ndescription: CLI");
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings).toEqual([`skills: ${join(root, "tavily", "SKILL.md")} name 'tavily-cli' must match directory name 'tavily'`]);
  });

  it("根下普通文件（非目录）静默忽略、无告警", async () => {
    await writeSkill("alpha", "name: alpha\ndescription: does A");
    await writeFile(join(root, "README.md"), "not a skill");
    const result = await loadSkills([root]);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.skills)).toEqual(["alpha"]);
  });

  it("目录缺席：空结果、无告警（未配置合法）", async () => {
    const result = await loadSkills([join(root, "no-such-dir")]);
    expect(result).toEqual({ skills: {}, warnings: [] });
  });

  it("SKILL.md 超 1MB 拒注册（读前 stat 拦截）", async () => {
    const dir = join(root, "huge");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: huge\ndescription: x\n---\n${"a".repeat(1024 * 1024)}`);
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings[0]).toContain("exceeds 1MB limit");
  });

  it("捆绑文件与 SKILL.md 共存不影响装载", async () => {
    const dir = await writeSkill("alpha", "name: alpha\ndescription: does A");
    await writeFile(join(dir, "helper.sh"), "echo hi");
    await mkdir(join(dir, "refs"), { recursive: true });
    const result = await loadSkills([root]);
    expect(Object.keys(result.skills)).toEqual(["alpha"]);
    expect(result.warnings).toEqual([]);
  });

  it("symlink 目录跟随加载（stow/dotfiles 摆放；skill 名 = 链接名）", async () => {
    const outside = await mkdtemp(join(tmpdir(), "xh-skills-out-"));
    try {
      await writeFile(join(outside, "SKILL.md"), "---\nname: linked\ndescription: via link\n---\n");
      await symlink(outside, join(root, "linked"));
      const result = await loadSkills([root]);
      expect(result.skills).toEqual({ linked: { name: "linked", description: "via link", path: join(root, "linked", "SKILL.md") } });
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("断链 symlink 静默忽略（与普通文件同策）", async () => {
    await symlink(join(root, "no-target"), join(root, "dangling"));
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("SKILL.md 是目录（非普通文件）拒注册告警", async () => {
    await mkdir(join(root, "weird", "SKILL.md"), { recursive: true });
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings.some((warning) => warning.includes("is not a regular file"))).toBe(true);
  });

  // root 运行时 chmod 不产生 EACCES——权限用例仅在非 root 生效
  it.skipIf(process.getuid?.() === 0)("SKILL.md 不可读（EACCES）拒注册告警", async () => {
    const dir = await writeSkill("locked", "name: locked\ndescription: x");
    await chmod(join(dir, "SKILL.md"), 0o000);
    const result = await loadSkills([root]);
    expect(result.skills).toEqual({});
    expect(result.warnings.some((warning) => warning.startsWith("skills: unreadable"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("skills 根不可读（EACCES，非缺席）告警不静默", async () => {
    try {
      await chmod(root, 0o000);
      const result = await loadSkills([root]);
      expect(result.skills).toEqual({});
      expect(result.warnings.some((warning) => warning.startsWith("skills: unreadable directory"))).toBe(true);
    } finally {
      await chmod(root, 0o755);
    }
  });
});
