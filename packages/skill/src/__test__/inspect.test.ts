// inspectSkillDir / skillNameMismatch 表驱动（docs/SKILL-INSTALL.md §1.1、§7）：七个
// 问题码逐码一条 + 成功形态 + 目录名对齐规则。断言用**逐字文案**——装载器直接透传
// inspected.message 作告警，此处即告警文案的单一事实（与 docs/SKILL.md §7 既有口径
// 逐字一致）。

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectSkillDir, skillNameMismatch } from "../inspect.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xh-inspect-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(name: string, text: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text);
  return dir;
}

describe("inspectSkillDir", () => {
  it("可解析技能：name/description/path 三字段（path = SKILL.md 绝对路径）", async () => {
    const dir = await writeSkill("alpha", "---\nname: alpha\ndescription: does A\nextra: 不消费\n---\nbody");
    expect(await inspectSkillDir(dir)).toEqual({ ok: true, name: "alpha", description: "does A", path: join(dir, "SKILL.md") });
  });

  it("声明名与目录名不符不是失败（对齐规则是装载器注册条件，不是解析条件）", async () => {
    const dir = await writeSkill("tavily", "---\nname: tavily-cli\ndescription: CLI\n---\n");
    expect(await inspectSkillDir(dir)).toEqual({ ok: true, name: "tavily-cli", description: "CLI", path: join(dir, "SKILL.md") });
  });

  it.each([
    ["SKILL.md 缺席（目录在）", "dir", "ENOENT"],
    ["目录缺席", "ghost", "ENOENT"],
    ["路径是普通文件（非目录）", "file", "ENOTDIR"],
  ])("问题码 not_found 族：%s", async (_label, kind, errno) => {
    let dir: string;
    if (kind === "dir") {
      dir = join(root, "emptydir");
      await mkdir(dir, { recursive: true });
    } else if (kind === "file") {
      dir = join(root, "plainfile");
      await writeFile(dir, "x");
    } else {
      dir = join(root, "absent");
    }
    expect(await inspectSkillDir(dir)).toEqual({ ok: false, problem: "not_found", message: `skills: unreadable ${join(dir, "SKILL.md")} (${errno})` });
  });

  it("SKILL.md 是目录 → not_regular_file", async () => {
    const dir = join(root, "asdir");
    await mkdir(join(dir, "SKILL.md"), { recursive: true });
    expect(await inspectSkillDir(dir)).toEqual({ ok: false, problem: "not_regular_file", message: `skills: ${join(dir, "SKILL.md")} is not a regular file` });
  });

  it("超 1MB（读前 stat 拦截）→ too_large，message 含字节数", async () => {
    const dir = await writeSkill("huge", `---\nname: huge\ndescription: x\n---\n${"a".repeat(1024 * 1024)}`);
    const outcome = await inspectSkillDir(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe("too_large");
    expect(outcome.message).toMatch(/^skills: .*SKILL\.md exceeds 1MB limit \(\d+ bytes\)$/);
  });

  it("无 frontmatter → no_frontmatter", async () => {
    const dir = await writeSkill("nofm", "no frontmatter here");
    expect(await inspectSkillDir(dir)).toEqual({ ok: false, problem: "no_frontmatter", message: `skills: ${join(dir, "SKILL.md")} has no frontmatter` });
  });

  it.each([
    ["无冒号行", "---\nname alpha\ndescription: x\n---\n"],
    ["空键行", "---\nname: alpha\n: x\n---\n"],
  ])("frontmatter 非扁平 → frontmatter_not_flat：%s", async (_label, text) => {
    const dir = await writeSkill("broken", text);
    expect(await inspectSkillDir(dir)).toEqual({ ok: false, problem: "frontmatter_not_flat", message: `skills: ${join(dir, "SKILL.md")} frontmatter is not flat key: value lines` });
  });

  it.each([
    ["缺 name", "---\ndescription: x\n---\n"],
    ["缺 description", "---\nname: alpha\n---\n"],
  ])("缺字段 → missing_fields：%s", async (_label, text) => {
    const dir = await writeSkill("alpha", text);
    expect(await inspectSkillDir(dir)).toEqual({ ok: false, problem: "missing_fields", message: `skills: ${join(dir, "SKILL.md")} missing required name/description` });
  });

  // root 运行时 chmod 不产生 EACCES——权限用例仅在非 root 生效
  it.skipIf(process.getuid?.() === 0)("SKILL.md 不可读（EACCES）→ unreadable（区别于 not_found）", async () => {
    const dir = await writeSkill("locked", "---\nname: locked\ndescription: x\n---\n");
    await chmod(join(dir, "SKILL.md"), 0o000);
    const outcome = await inspectSkillDir(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toBe("unreadable");
    expect(outcome.message).toBe(`skills: unreadable ${join(dir, "SKILL.md")} (EACCES)`);
  });
});

describe("skillNameMismatch", () => {
  it("齐名 → undefined", () => {
    expect(skillNameMismatch(join(root, "alpha"), "alpha")).toBeUndefined();
  });

  it("不齐 → 装载器原话告警文案（含目录名与文件路径）", () => {
    expect(skillNameMismatch(join(root, "tavily"), "tavily-cli")).toBe(`skills: ${join(root, "tavily", "SKILL.md")} name 'tavily-cli' must match directory name 'tavily'`);
  });
});
