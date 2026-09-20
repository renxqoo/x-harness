// adapterOptionsOf 装配直测（docs/PROVIDER-MAX-OUTPUT-TOKENS.md）：档案字段 → 两工厂选项的
// 键形态断言（在场携带/缺席不出现——防 spread 键名拼错静默绿）。

import { describe, expect, it } from "vitest";
import { adapterOptionsOf } from "../build-world.ts";
import type { ProviderProfile } from "../providers-file.ts";

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: "glm",
    protocol: "anthropic",
    baseUrl: "https://api.example.com",
    apiKey: "sk-file",
    models: ["glm-4.7"],
    ...over,
  };
}

describe("adapterOptionsOf", () => {
  it("可选字段缺席 → 键不出现（两协议同构）", () => {
    for (const protocol of ["anthropic", "openai"] as const) {
      const options = adapterOptionsOf(profile({ protocol }), "sk-file");
      expect(options).toEqual({ name: "glm", baseUrl: "https://api.example.com", apiKey: "sk-file" });
      expect(Object.hasOwn(options, "contextWindow")).toBe(false);
      expect(Object.hasOwn(options, "maxOutputTokens")).toBe(false);
    }
  });

  it("contextWindow/maxOutputTokens 在场 → 两协议都携带；apiKey 参数覆盖档案值", () => {
    for (const protocol of ["anthropic", "openai"] as const) {
      expect(adapterOptionsOf(profile({ protocol, contextWindow: 200_000, maxOutputTokens: 4096 }), "sk-override")).toEqual({
        name: "glm",
        baseUrl: "https://api.example.com",
        apiKey: "sk-override",
        contextWindow: 200_000,
        maxOutputTokens: 4096,
      });
    }
  });
});
