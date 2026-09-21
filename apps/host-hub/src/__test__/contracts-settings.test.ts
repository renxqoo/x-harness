// settings-store/atomic-file 契约（MIGRATION §5 settings 块移植 + x-harness 词表）：
// 白名单键值校验、坏文件降级方向、双级合并（覆盖型项目胜/名单并集）、分链串行 +
// 回收有界、normalizeCwd 降级。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeAtomicPaths, atomicWriteJson, readJson, updateJson } from "../shared/atomic-file.ts";
import {
  activeSettingPaths,
  mergeSettings,
  normalizeCwd,
  projectSettingsPath,
  readSettingsFile,
  updateSettingsFile,
  userSettingsPath,
  validateSettingValue,
} from "../shared/settings-store.ts";

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-settings-"));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("atomic-file", () => {
  test("原子写 + 读回；坏 JSON 读 fallback", async () => {
    const dir = await tempDir();
    const path = join(dir, "a.json");
    await atomicWriteJson(path, { x: 1 });
    expect(await readJson(path, null)).toEqual({ x: 1 });
    expect(await readJson(join(dir, "missing.json"), "fb")).toBe("fb");
  });

  test("同路径串行不丢更新；异路径不互堵；链空闲回收", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await Promise.all([
      updateJson<number>(a, { read: async () => 0, write: async (n) => atomicWriteJson(a, n), mutate: (n) => n + 1 }),
      updateJson<number>(a, { read: async () => Number(await readJson(a, 0)), write: async (n) => atomicWriteJson(a, n), mutate: (n) => n + 10 }),
      updateJson<number>(b, { read: async () => 0, write: async (n) => atomicWriteJson(b, n), mutate: (n) => n + 100 }),
    ]);
    expect(await readJson<number>(a, -1)).toBe(11);
    expect(await readJson<number>(b, -1)).toBe(100);
    await new Promise((r) => { setTimeout(r, 5); });
    expect(activeAtomicPaths()).toBe(0);
  });
});

describe("settings-store", () => {
  test("白名单键值校验（x-harness 词表：mode plan|auto|full；thinking +max）", () => {
    expect(validateSettingValue("permission.defaultMode", "auto")).toEqual({ ok: true, key: "permission.defaultMode" });
    expect(validateSettingValue("permission.defaultMode", "fullAuto").ok).toBe(false);
    expect(validateSettingValue("thinking.default", "max")).toEqual({ ok: true, key: "thinking.default" });
    expect(validateSettingValue("thinking.default", "huge").ok).toBe(false);
    expect(validateSettingValue("skills.disabled", ["a"]).ok).toBe(true);
    expect(validateSettingValue("skills.disabled", "a").ok).toBe(false);
    expect(validateSettingValue("unknown.key", 1)).toEqual({ ok: false, error: { code: "invalid_input", message: "unknown setting key: unknown.key" } });
  });

  test("缺席/坏文件/坏值降级（安全向：逐键丢、不崩）", async () => {
    const dir = await tempDir();
    expect(await readSettingsFile(join(dir, "none.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    await Bun.write(bad, "{not json");
    expect(await readSettingsFile(bad)).toEqual({});
    const mixed = join(dir, "mixed.json");
    await Bun.write(mixed, JSON.stringify({ "thinking.default": "low", "permission.defaultMode": "bogus", other: 1 }));
    expect(await readSettingsFile(mixed)).toEqual({ "thinking.default": "low" });
  });

  test("路径单源：用户级/项目级", async () => {
    expect(userSettingsPath("/hub")).toBe(join("/hub", "hub-settings.json"));
    expect(projectSettingsPath("/w")).toBe(join("/w", ".x-harness", "hub-settings.json"));
  });

  test("分链串行 RMW + 回收有界", async () => {
    const dir = await tempDir();
    const path = join(dir, "hub-settings.json");
    await Promise.all([
      updateSettingsFile(path, (cur) => ({ ...cur, "thinking.default": "low" })),
      updateSettingsFile(path, (cur) => ({ ...cur, "permission.defaultMode": "full" })),
    ]);
    const final = await readSettingsFile(path);
    expect(final).toEqual({ "thinking.default": "low", "permission.defaultMode": "full" });
    await new Promise((r) => { setTimeout(r, 5); });
    expect(activeSettingPaths()).toBe(0);
  });

  test("合并视图：覆盖型项目胜；名单并集；来源标注", () => {
    const user = { "permission.defaultMode": "auto" as const, "thinking.default": "low" as const, "skills.disabled": ["a", "b"] };
    const project = { "permission.defaultMode": "full" as const, "skills.disabled": ["b", "c"] };
    const merged = mergeSettings(user, project);
    expect(merged.values).toEqual({
      "permission.defaultMode": "full",
      "thinking.default": "low",
      "skills.disabled": ["a", "b", "c"],
    });
    expect(merged.sources).toEqual({
      "permission.defaultMode": "project",
      "thinking.default": "user",
      "skills.disabled": "union",
    });
    expect(mergeSettings({}, {}).values).toEqual({});
  });

  test("normalizeCwd：尾斜杠/失败降级 resolve", async () => {
    const dir = await tempDir();
    expect(await normalizeCwd(`${dir}/`)).toBe(await normalizeCwd(dir));
    expect(await normalizeCwd("/definitely/missing/../path")).toBe("/definitely/path");
  });
});
