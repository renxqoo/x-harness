import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSettingValue, mergeSettings, readSettingsFile, projectSettingsPath } from "../shared/settings-store.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("settings 键校验（单点）", () => {
  test("permission.defaultMode 五档词表", () => {
    expect(validateSettingValue("permission.defaultMode", "auto")).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.defaultMode", "sandboxed-auto")).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.defaultMode", "edit-confirm")).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.defaultMode", "fast")).toMatchObject({ ok: false });
  });

  test("permission.rules：条目形态 + grant 恒 allow；坏形态拒", () => {
    expect(validateSettingValue("permission.rules", [{ tool: "Danger", pattern: "npm install:*", verdict: "allow", nature: "grant", at: 1 }])).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.rules", [{ tool: "Danger", pattern: "x", verdict: "deny", nature: "handwritten" }])).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.rules", [{ tool: "Danger", pattern: "x", verdict: "deny", nature: "grant" }])).toMatchObject({ ok: false });
    expect(validateSettingValue("permission.rules", [{ tool: "Fax", pattern: "x", verdict: "allow", nature: "handwritten" }])).toMatchObject({ ok: false });
    expect(validateSettingValue("permission.rules", "Danger(x):allow")).toMatchObject({ ok: false });
  });

  test("permission.profiles：形态合法 + 内置保留名拒", () => {
    expect(validateSettingValue("permission.profiles", [{ id: "strict", askPolicy: "always", containment: "fenced", mutationPolicy: "confirm-all" }])).toMatchObject({ ok: true });
    expect(validateSettingValue("permission.profiles", [{ id: "full", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" }])).toMatchObject({ ok: false });
    expect(validateSettingValue("permission.profiles", [{ id: "x", askPolicy: "nope", containment: "none", mutationPolicy: "auto-in-root" }])).toMatchObject({ ok: false });
  });
});

describe("mergeSettings（规则并集语义）", () => {
  test("同 (tool,pattern) 项目压用户；异键并集", () => {
    const user = { "permission.rules": [{ tool: "Danger" as const, pattern: "a:*", verdict: "allow" as const, nature: "handwritten" as const }, { tool: "Read" as const, pattern: "~/docs/**", verdict: "allow" as const, nature: "handwritten" as const }] };
    const project = { "permission.rules": [{ tool: "Danger" as const, pattern: "a:*", verdict: "deny" as const, nature: "handwritten" as const }] };
    const merged = mergeSettings(user, project).values["permission.rules"] ?? [];
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.pattern === "a:*")?.verdict).toBe("deny");
    expect(merged.some((r) => r.pattern === "~/docs/**")).toBe(true);
  });
});

describe("坏文件降级与读入", () => {
  test("规则键含坏条目 → 单条降级保留好条目（R5——旧整键静默清空让断代词条陪葬全部 deny）", async () => {
    const dir = await tempDir("xh-setread-");
    const path = join(dir, "hub-settings.json");
    await writeFile(path, JSON.stringify({ "permission.rules": [{ tool: "Danger", pattern: "ok:*", verdict: "allow", nature: "grant" }, { tool: "Danger", verdict: "allow", nature: "handwritten" }], "unknown.key": 1 }), "utf8");
    const settings = await readSettingsFile(path);
    expect(settings["permission.rules"]).toEqual([{ tool: "Danger", pattern: "ok:*", verdict: "allow", nature: "grant" }]);
  });

  test("projectSettingsPath 锚（保护路径接线面——U13）", async () => {
    const cwd = await tempDir("xh-setpath-");
    await mkdir(join(cwd, ".x-harness"), { recursive: true });
    expect(projectSettingsPath(cwd)).toBe(join(cwd, ".x-harness", "hub-settings.json"));
  });
});
