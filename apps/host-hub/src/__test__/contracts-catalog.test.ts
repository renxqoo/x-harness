// catalog 契约：预设兜底、custom 覆盖、modelOverrides 双键、坏文件降级、装配快照
// apiKey 解析序、缺省拨号解析。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssemblySnapshot, readCatalog, resolveDefaultDial } from "../shared/catalog.ts";

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-catalog-"));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("catalog", () => {
  test("首跑零配置：预设集可启动；缺省拨号 = 预设", async () => {
    const dir = await tempDir();
    const catalog = await readCatalog(dir);
    expect(catalog.degraded).toBe(false);
    expect(catalog.entries.length).toBeGreaterThan(0);
    expect(catalog.entries.every((e) => e.source === "preset")).toBe(true);
    expect(resolveDefaultDial(catalog)).toEqual({ provider: "glm", model: "glm-5.3" });
    const glm = catalog.entries.find((e) => e.model === "glm-5.3");
    expect(glm?.contextWindow).toBe(1_000_000);
    expect(glm?.reasoning).toBe(true);
    expect(glm?.cost).toEqual({ input: 8, output: 16, cacheRead: 1, cacheWrite: 0 });
  });

  test("custom 档案同名整档覆盖预设；档案级/模型级缺省链", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [
        {
          name: "glm",
          protocol: "anthropic",
          baseUrl: "https://proxy.example",
          apiKeyEnv: "MY_KEY",
          models: ["glm-5.3", { id: "glm-5.3-air", contextWindow: 128_000 }],
          contextWindow: 512_000,
          maxOutputTokens: 16_000,
        },
      ],
    }));
    const catalog = await readCatalog(dir);
    expect(catalog.degraded).toBe(false);
    const all = catalog.entries.filter((e) => e.provider === "glm");
    expect(all.map((e) => e.source)).toEqual(["custom", "custom"]);
    const base = all.find((e) => e.model === "glm-5.3");
    expect(base?.baseUrl).toBe("https://proxy.example");
    expect(base?.contextWindow).toBe(512_000); // 模型级缺席 → 档案级
    const air = all.find((e) => e.model === "glm-5.3-air");
    expect(air?.contextWindow).toBe(128_000); // 模型级胜
    expect(air?.maxTokens).toBe(16_000); // 模型级缺席 → 档案级
    expect(air?.apiKeyEnv).toBe("MY_KEY");
    // file.default 缺席 → 预设缺省
    expect(catalog.defaults).toEqual({ provider: "glm", model: "glm-5.3" });
  });

  test("file.default 覆写缺省；挤出目录时回落首条", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [{ name: "p2", protocol: "openai", baseUrl: "https://p2.example", models: ["m2"] }],
      default: { provider: "glm", model: "glm-5.3" },
    }));
    const catalog = await readCatalog(dir);
    expect(resolveDefaultDial(catalog)).toEqual({ provider: "glm", model: "glm-5.3" });
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [{ name: "p2", protocol: "openai", baseUrl: "https://p2.example", models: ["m2"] }],
      default: { provider: "gone", model: "x" },
    }));
    const fallback = await readCatalog(dir);
    // 回落首条 = custom 档案优先序（用户显式配置压过预设——裸 id 撞名消歧同口径）
    expect(resolveDefaultDial(fallback)).toEqual({ provider: "p2", model: "m2" });
  });

  test("裸 modelId 撞名消歧 custom 优先（custom 与预设同名模型——用户配置压过无凭据预设）", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [{ name: "my-glm", protocol: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "MY_KEY", models: ["glm-5.3"] }],
    }));
    const catalog = await readCatalog(dir);
    const entry = catalog.entries.find((e) => e.model === "glm-5.3");
    expect(entry?.source).toBe("custom");
    expect(entry?.provider).toBe("my-glm");
  });

  test("modelOverrides 双键命中覆写（复合键整对象优先于裸键——不跨键合并）", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [],
      modelOverrides: { "glm::glm-5.3": { contextWindow: 64_000 }, "glm-5.3": { maxOutputTokens: 4_096 } },
    }));
    const catalog = await readCatalog(dir);
    const glm = catalog.entries.find((e) => e.model === "glm-5.3");
    // 复合键命中即整对象生效：裸键不再合并（maxTokens 保持预设 34_000）
    expect(glm?.contextWindow).toBe(64_000);
    expect(glm?.maxTokens).toBe(34_000);
    // 复合键缺席时裸键生效
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [],
      modelOverrides: { "glm-5.3": { maxOutputTokens: 4_096 } },
    }));
    const bare = await readCatalog(dir);
    const glmBare = bare.entries.find((e) => e.model === "glm-5.3");
    expect(glmBare?.maxTokens).toBe(4_096);
  });

  test("坏 JSON / 垃圾档案 → degraded（预设仍可用）", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), "{oops");
    expect((await readCatalog(dir)).degraded).toBe(true);
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [{ name: "", protocol: "anthropic", baseUrl: "http://x", models: ["m"] }, { name: "ok", protocol: "openai", baseUrl: "https://ok.example", models: ["m"] }],
    }));
    const catalog = await readCatalog(dir);
    expect(catalog.degraded).toBe(true);
    expect(catalog.entries.some((e) => e.provider === "ok")).toBe(true);
    expect(catalog.entries.some((e) => e.provider === "")).toBe(false);
  });

  test("装配快照 maxOutputTokensByModel：模型级 meta 与 modelOverrides 都进快照；模型级胜档案级；与 get_models 展示值同源", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [
        {
          name: "p",
          protocol: "anthropic",
          baseUrl: "https://p.example",
          models: [
            { id: "with-meta", maxTokens: 12_000 }, // 模型级 meta
            "bare-model", // 裸 id：档案级缺省解析后仍进 byModel（entries 已解析值）
            { id: "no-limit" }, // 模型级缺席且档案级缺席 → 不进 byModel
          ],
          maxOutputTokens: 4_000, // 档案级：bare-model 的解析值
        },
      ],
      modelOverrides: { "p::with-meta": { maxOutputTokens: 99_999 } }, // override 覆写 meta
    }));
    const catalog = await readCatalog(dir);
    const snap = buildAssemblySnapshot(catalog, {}, {});
    const byName = new Map(snap.map((p) => [p.provider, p]));
    // no-limit 也解析为档案级 4_000（entries 已解析值单源——模型级缺席回落档案级）
    expect(byName.get("p")?.maxOutputTokensByModel).toEqual({ "with-meta": 99_999, "bare-model": 4_000, "no-limit": 4_000 });
    // 同源断言：快照值 = get_models 展示面 entry.maxTokens（entryOf+applyOverride 单源）
    const shown = new Map(catalog.entries.filter((e) => e.provider === "p").map((e) => [e.model, e.maxTokens]));
    for (const [model, value] of Object.entries(byName.get("p")?.maxOutputTokensByModel ?? {})) {
      expect(shown.get(model)).toBe(value);
    }
    expect(shown.get("with-meta")).toBe(99_999); // override 值胜模型级 meta（展示与快照同值）
    expect(byName.get("p")?.maxOutputTokens).toBe(4_000); // 档案级字段保持原样（profile 级兜底面不变）
  });

  test("装配快照 maxOutputTokensByModel：档案无任何模型级值时不发该字段", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [{ name: "q", protocol: "openai", baseUrl: "https://q.example", models: ["m1"] }],
    }));
    const catalog = await readCatalog(dir);
    const snap = buildAssemblySnapshot(catalog, {}, {});
    const q = snap.find((p) => p.provider === "q");
    expect(q && Object.hasOwn(q, "maxOutputTokensByModel")).toBe(false);
  });

  test("装配快照 apiKey 解析序：credentials > 档案字面 > apiKeyEnv env > 空", async () => {
    const dir = await tempDir();
    await Bun.write(join(dir, "providers.json"), JSON.stringify({
      providers: [
        { name: "a", protocol: "openai", baseUrl: "https://a.example", apiKey: "literal", models: ["m1"] },
        { name: "b", protocol: "openai", baseUrl: "https://b.example", apiKeyEnv: "B_KEY", models: ["m2"] },
        { name: "c", protocol: "openai", baseUrl: "https://c.example", models: ["m3"] },
      ],
    }));
    const catalog = await readCatalog(dir);
    const snap = buildAssemblySnapshot(catalog, { a: "cred", c: "cred-c" }, { B_KEY: "env-key" });
    const byName = new Map(snap.map((p) => [p.provider, p]));
    expect(byName.get("a")?.apiKey).toBe("cred"); // credentials 胜档案字面
    expect(byName.get("b")?.apiKey).toBe("env-key");
    expect(byName.get("c")?.apiKey).toBe("cred-c");
    expect(byName.get("glm")?.apiKey).toBe(""); // 预设 env 缺席 = 空（auth/list 面 none）
    expect(byName.get("a")?.models).toEqual(["m1"]);
  });
});
