// types-loader 纯函数直测（docs/AGENT-DELEGATION.md §7.1/§11.2）：frontmatter 解析、
// 垃圾输入降级、目录优先级、保留名、指纹探测。

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadAgentTypes, resolveAgentDirs, typesFingerprint } from "../types-loader.ts";

let dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xh-types-"));
  dirs = [...dirs, dir];
  return dir;
}

describe("resolveAgentDirs（三级解析）", () => {
  it("显式配置 > 环境变量 > 缺省（cwd + 用户目录）", async () => {
    expect(resolveAgentDirs(["/custom"])).toEqual(["/custom"]);
    process.env["X_HARNESS_AGENTS_DIRS"] = "/a:/b:";
    try {
      expect(resolveAgentDirs()).toEqual(["/a", "/b"]);
    } finally {
      delete process.env["X_HARNESS_AGENTS_DIRS"];
    }
    expect(resolveAgentDirs()).toEqual([join(process.cwd(), ".x-harness", "agents"), join(homedir(), ".x-harness", "agents")]);
  });
});

describe("loadAgentTypes", () => {
  it("合法文件：字段齐全（tools 逗号切分 trim、正文为 prompt）；缺席目录合法", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "explore.md"), "---\nname: explore\ndescription: 只读搜索\nmodel: m-1\nprovider: p-1\ntools: read , grep ,, bash\n---\nyou search");
    const { types, warnings } = await loadAgentTypes([dir, join(dir, "nope")]);
    expect(warnings).toEqual([]);
    expect(types["explore"]).toMatchObject({ name: "explore", model: "m-1", provider: "p-1", tools: ["read", "grep", "bash"], prompt: "you search" });
  });

  it("目录优先级降序同名前者胜（前者覆盖后者）", async () => {
    const high = await makeDir();
    const low = await makeDir();
    await writeFile(join(high, "t.md"), "---\nname: t\ndescription: high\n---\nH");
    await writeFile(join(low, "t.md"), "---\nname: t\ndescription: low\n---\nL");
    const { types } = await loadAgentTypes([high, low]);
    expect(types["t"]?.description).toBe("high");
  });

  it("垃圾输入降级：缺必填/名不匹配/保留名/无 frontmatter/非扁平——拒注册 + 告警，不 throw", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "missing.md"), "---\nname: missing\n---\nbody");
    await writeFile(join(dir, "mismatch.md"), "---\nname: other\ndescription: x\n---\nbody");
    await writeFile(join(dir, "fork.md"), "---\nname: fork\ndescription: x\n---\nbody");
    await writeFile(join(dir, "main.md"), "---\nname: main\ndescription: x\n---\nbody");
    await writeFile(join(dir, "nofm.md"), "just body");
    await writeFile(join(dir, "nested.md"), "---\nname: nested\ndescription: x\n  indented line no colon\n---\nbody");
    const { types, warnings } = await loadAgentTypes([dir]);
    expect(Object.keys(types)).toEqual([]);
    expect(warnings).toHaveLength(6);
    expect(warnings.join("\n")).toContain("missing required name/description");
    expect(warnings.join("\n")).toContain("must match filename");
    expect(warnings.join("\n")).toContain("reserved type name 'fork'");
    expect(warnings.join("\n")).toContain("reserved type name 'main'");
    expect(warnings.join("\n")).toContain("has no frontmatter");
    expect(warnings.join("\n")).toContain("not flat");
  });

  it("不可读文件 → 告警不 throw", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "locked.md"), "---\nname: locked\ndescription: x\n---\nb", { mode: 0o000 });
    const { types, warnings } = await loadAgentTypes([dir]);
    expect(types["locked"]).toBeUndefined();
    expect(warnings.join("\n")).toContain("unreadable");
  });
});

describe("typesFingerprint（kick 边沿探测判据）", () => {
  it("目录缺席 → 空指纹；写入/修改改变指纹", async () => {
    const dir = await makeDir();
    expect(await typesFingerprint([dir])).toBe("");
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: x\n---\n");
    const withFile = await typesFingerprint([dir]);
    expect(withFile).toContain("a.md");
    await mkdir(join(dir, "sub"), { recursive: true }); // 非 .md 目录不计
    expect(await typesFingerprint([dir])).toBe(withFile);
    await writeFile(join(dir, "a.md"), "---\nname: a\ndescription: y\n---\n");
    expect(await typesFingerprint([dir])).not.toBe(withFile);
  });
});

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});
