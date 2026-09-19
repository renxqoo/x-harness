// resolveModel 两层解析（docs/CLI.md §2.6）：新建 defaults 合成 vs resume 仅显式 overrides、
// --provider/--model 归属矩阵（唯一命中/歧义/未命中）、--api-key 绑定 provider。

import { describe, expect, it } from "vitest";
import { parseProvidersConfig } from "../providers-file.ts";
import { resolveModel } from "../resolve-model.ts";

const single = parseProvidersConfig({
  providers: [{ name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["glm-4.7", "glm-4.7-flash"] }],
});
const dual = parseProvidersConfig({
  providers: [
    { name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["glm-4.7", "shared-m"] },
    { name: "ovt", protocol: "openai", baseUrl: "https://b", apiKey: "k2", models: ["qwen3", "shared-m"] },
  ],
  default: { provider: "glm", model: "glm-4.7", thinking: "medium" },
});

if (!single.ok || !dual.ok) throw new Error("test fixture config invalid");

describe("defaults 层（新建会话用）", () => {
  it("无 flag → config default 原样（thinking off 转为缺席不发）", () => {
    const resolved = resolveModel(single.value, {});
    expect(resolved.ok && resolved.value.defaults).toEqual({ provider: "glm", model: "glm-4.7" });
  });

  it("default.thinking 非 off 保留；--thinking 覆盖", () => {
    const base = resolveModel(dual.value, {});
    expect(base.ok && base.value.defaults.thinking).toBe("medium");
    const high = resolveModel(dual.value, { thinking: "high" });
    expect(high.ok && high.value.defaults.thinking).toBe("high");
    const off = resolveModel(dual.value, { thinking: "off" });
    expect(off.ok && off.value.defaults.thinking).toBeUndefined();
  });

  it("--provider 切档案，model 回落该档案内 default 可行项（default.model 不在该档案时报错）", () => {
    const ovtDefault = parseProvidersConfig({
      providers: [
        { name: "glm", protocol: "anthropic", baseUrl: "https://a", apiKey: "k", models: ["glm-4.7"] },
        { name: "ovt", protocol: "openai", baseUrl: "https://b", apiKey: "k2", models: ["qwen3"] },
      ],
      default: { provider: "glm", model: "glm-4.7" },
    });
    if (!ovtDefault.ok) throw new Error("fixture invalid");
    const bare = resolveModel(ovtDefault.value, { provider: "ovt" });
    expect(bare.ok).toBe(false);
    const paired = resolveModel(ovtDefault.value, { provider: "ovt", model: "qwen3" });
    expect(paired.ok && paired.value.defaults).toEqual({ provider: "ovt", model: "qwen3" });
  });
});

describe("--model 归属（无 --provider）", () => {
  it("全档案唯一命中 → 归属该档案", () => {
    const resolved = resolveModel(dual.value, { model: "qwen3" });
    expect(resolved.ok && resolved.value.defaults.provider).toBe("ovt");
  });

  it("跨档案歧义 → 报错并列出候选 provider", () => {
    const resolved = resolveModel(dual.value, { model: "shared-m" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("ambiguous");
      expect(resolved.reason).toContain("ovt");
    }
  });

  it("零命中 → 报错引导 --provider", () => {
    const resolved = resolveModel(dual.value, { model: "nope" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("not found in any provider");
  });

  it("--provider 在场时 model 必须落在该档案", () => {
    const resolved = resolveModel(dual.value, { provider: "ovt", model: "glm-4.7" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("is not in provider \"ovt\"");
  });

  it("--provider 未知 → 报错列已声明档案", () => {
    const resolved = resolveModel(dual.value, { provider: "nope" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("unknown provider");
  });
});

describe("overrides 层（resume 用）", () => {
  it("无 flag → overrides 全空（回落会话末次 dial）", () => {
    const resolved = resolveModel(dual.value, {});
    expect(resolved.ok && resolved.value.overrides).toEqual({});
  });

  it("仅显式 flag 进 overrides；defaults 层不受影响", () => {
    const resolved = resolveModel(dual.value, { thinking: "low" });
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.value.overrides).toEqual({ thinking: "low" });
    expect(resolved.value.defaults.thinking).toBe("low");
  });

  it("--model 唯一命中时 overrides 同时带 provider+model（折叠需要成对）", () => {
    const resolved = resolveModel(dual.value, { model: "qwen3" });
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.value.overrides).toEqual({ provider: "ovt", model: "qwen3" });
  });
});

describe("--api-key 绑定", () => {
  it("apiKeyProvider = 解析出的 provider；defaults/overrides 都带 apiKey", () => {
    const resolved = resolveModel(dual.value, { model: "qwen3", apiKey: "sk-override" });
    if (!resolved.ok) throw new Error("expected ok");
    expect(resolved.value.apiKeyProvider).toBe("ovt");
    expect(resolved.value.defaults.apiKey).toBe("sk-override");
    expect(resolved.value.overrides.apiKey).toBe("sk-override");
  });
});
