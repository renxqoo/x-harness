import { describe, expect, it } from "vitest";
import { inheritDial, splitDialRef } from "../lineage.ts";
import type { LoadedAgentType } from "../types.ts";

function parentHandle(model: string | undefined, provider: string | undefined) {
  return { agent: { options: { model, provider } } } as never;
}

describe("inheritDial 修正链（问题5顺序 + fallbackDial + 复合名短路）", () => {
  it("中途 set_model 后 spawn 继承最新模型（lastHeader 优先于创建时 options）", () => {
    const handle = parentHandle("glm-old", "GLM");
    const dial = inheritDial(handle, { lastHeader: { model: "glm-new", provider: "GLM" } });
    expect(dial).toEqual({ model: "glm-new", provider: "GLM" });
  });

  it("类型 md 的复合名拆出 provider，绕开 resolveProviderOf 歧义门", () => {
    const type: LoadedAgentType = { name: "general-purpose", description: "", model: "GLM/glm-5.3", prompt: "" };
    const handle = parentHandle("glm-old", "OTHER");
    const dial = inheritDial(handle, { type, resolveProviderOf: () => undefined });
    expect(dial).toEqual({ model: "glm-5.3", provider: "GLM" });
  });

  it("spawn 入参 override 优先于类型 md", () => {
    const type: LoadedAgentType = { name: "explore", description: "", model: "GLM/glm-5.3-flash", prompt: "" };
    const handle = parentHandle("glm-old", "GLM");
    const dial = inheritDial(handle, { type, override: { model: "deepseek/deepseek-flash" } });
    expect(dial).toEqual({ model: "deepseek-flash", provider: "deepseek" });
  });

  it("全链缺失时落到 fallbackDial（catalog 默认）", () => {
    const handle = parentHandle(undefined, undefined);
    const dial = inheritDial(handle, { fallback: { model: "glm-5.3", provider: "GLM" } });
    expect(dial).toEqual({ model: "glm-5.3", provider: "GLM" });
  });

  it("裸模型名经 resolveProviderOf 唯一 owner 反查", () => {
    const handle = parentHandle(undefined, undefined);
    const dial = inheritDial(handle, { lastHeader: { model: "deepseek-flash" }, resolveProviderOf: (m) => (m === "deepseek-flash" ? "deepseek" : undefined) });
    expect(dial).toEqual({ model: "deepseek-flash", provider: "deepseek" });
  });

  it("裸模型名歧义时回落父 provider", () => {
    const handle = parentHandle("glm-old", "GLM");
    const dial = inheritDial(handle, { override: { model: "glm-5.3" }, resolveProviderOf: () => undefined });
    expect(dial).toEqual({ model: "glm-5.3", provider: "GLM" });
  });

  it("splitDialRef 拒绝畸形复合名", () => {
    expect(splitDialRef("/x")).toBeUndefined();
    expect(splitDialRef("x/")).toBeUndefined();
    expect(splitDialRef("GLM/glm-5.3")).toEqual({ provider: "GLM", model: "glm-5.3" });
  });
});
