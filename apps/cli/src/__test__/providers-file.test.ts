// providers.json 契约（docs/CLI.md §2.2）：解析词表封闭 + default 缺省合成 + IO 错误指引。
// 表驱动：每条校验规则一个正例/错例；readProvidersConfig 的缺席/坏 JSON 指引单测。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProvidersConfig, readProvidersConfig } from "../providers-file.ts";
import type { ProviderProtocol } from "../providers-file.ts";

function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "glm",
    protocol: "anthropic",
    baseUrl: "https://api.example.com",
    apiKey: "sk-x",
    models: ["glm-4.7", "glm-4.7-flash"],
    ...over,
  };
}

function config(providers: Record<string, unknown>[], def?: Record<string, unknown>): unknown {
  return { providers, ...(def !== undefined ? { default: def } : {}) };
}

describe("parseProvidersConfig 正例", () => {
  it("完整两档案 + default 全通过", () => {
    const parsed = parseProvidersConfig(config([
      profile(),
      profile({ name: "other", protocol: "openai" as ProviderProtocol, models: ["m1"] }),
    ], { provider: "other", model: "m1", thinking: "high" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.providers).toHaveLength(2);
      expect(parsed.value.default).toEqual({ provider: "other", model: "m1", thinking: "high" });
    }
  });

  it("单档案无 default → 合成首个 model + thinking off", () => {
    const parsed = parseProvidersConfig(config([profile()]));
    expect(parsed).toEqual({
      ok: true,
      value: {
        providers: [expect.objectContaining({ name: "glm" })],
        default: { provider: "glm", model: "glm-4.7", thinking: "off" },
      },
    });
  });

  it("default.thinking 缺席 = off；可选字段缺席不出现", () => {
    const parsed = parseProvidersConfig(config([profile()], { provider: "glm", model: "glm-4.7" }));
    expect(parsed.ok && parsed.value.default.thinking).toBe("off");
    expect(parsed.ok && "contextWindow" in parsed.value.providers[0]!).toBe(false);
  });
});

describe("parseProvidersConfig 错例（表驱动）", () => {
  const cases: readonly { readonly name: string; readonly raw: unknown; readonly reasonIncludes: string }[] = [
    { name: "顶层非对象", raw: [], reasonIncludes: "top-level object" },
    { name: "providers 空数组", raw: { providers: [] }, reasonIncludes: "non-empty array" },
    { name: "档案非对象", raw: { providers: ["x"] }, reasonIncludes: "providers[0]: expected an object" },
    { name: "name 空", raw: config([profile({ name: " " })]), reasonIncludes: "name: expected a non-empty string" },
    { name: "protocol 非法", raw: config([profile({ protocol: "grpc" })]), reasonIncludes: "protocol: expected one of anthropic | openai" },
    { name: "baseUrl 非 http(s)", raw: config([profile({ baseUrl: "ftp://x" })]), reasonIncludes: "baseUrl: expected an http(s) URL" },
    { name: "apiKey 空", raw: config([profile({ apiKey: "" })]), reasonIncludes: "apiKey: expected a non-empty string" },
    { name: "models 空", raw: config([profile({ models: [] })]), reasonIncludes: "models: expected a non-empty array" },
    { name: "models 重复项", raw: config([profile({ models: ["a", "a"] })]), reasonIncludes: "duplicate entries" },
    { name: "contextWindow 非正整数", raw: config([profile({ contextWindow: 1.5 })]), reasonIncludes: "contextWindow: expected a positive integer" },
    { name: "openai 档带 maxTokensDefault", raw: config([profile({ protocol: "openai", maxTokensDefault: 10 })]), reasonIncludes: "maxTokensDefault: only supported for the anthropic protocol" },
    { name: "maxTokensDefault 非正整数", raw: config([profile({ maxTokensDefault: 0 })]), reasonIncludes: "maxTokensDefault: expected a positive integer" },
    { name: "档案重名", raw: config([profile(), profile()]), reasonIncludes: "duplicate provider name" },
    { name: "多档案无 default", raw: config([profile(), profile({ name: "b" })]), reasonIncludes: "default: required when more than one provider" },
    { name: "default 指向缺席 provider", raw: config([profile()], { provider: "nope", model: "glm-4.7" }), reasonIncludes: "unknown provider" },
    { name: "default.model 不在档案内", raw: config([profile()], { provider: "glm", model: "zzz" }), reasonIncludes: "is not in provider" },
    { name: "default.thinking 非法", raw: config([profile()], { provider: "glm", model: "glm-4.7", thinking: "xhigh" }), reasonIncludes: "default.thinking: expected one of" },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.reasonIncludes}`, () => {
      const parsed = parseProvidersConfig(testCase.raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain(testCase.reasonIncludes);
    });
  }
});

describe("readProvidersConfig", () => {
  it("缺席 → 报文含路径与创建指引（含 0600 建议）", async () => {
    const parsed = await readProvidersConfig(join(tmpdir(), "xh-missing", "providers.json"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("no providers config at");
      expect(parsed.reason).toContain("chmod 600");
    }
  });

  it("坏 JSON → invalid JSON + 路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xh-providers-"));
    try {
      const path = join(dir, "providers.json");
      await writeFile(path, "{ nope", "utf8");
      const parsed = await readProvidersConfig(path);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("invalid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("合法文件 → 解析通过并保留路径上下文独立", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xh-providers-"));
    try {
      const path = join(dir, "providers.json");
      await writeFile(path, JSON.stringify(config([profile()])), "utf8");
      const parsed = await readProvidersConfig(path);
      expect(parsed.ok && parsed.value.default.provider).toBe("glm");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
