import { describe, expect, it } from "vitest";
import { createModeRegistry } from "../modes.ts";
import type { ModePlugin } from "../modes.ts";

describe("模式注册表（V4 双面协议）", () => {
  it("register/resolve/注销（身份守卫——旧 disposer 不注销新注册）；同 id 后者胜", () => {
    const registry = createModeRegistry();
    const a: ModePlugin = { id: "x", decide: () => ({ verdict: "allow", reason: "a", resolvedBy: "a" }) };
    const b: ModePlugin = { id: "x", posture: () => ({ verdict: "deny", reason: "b", resolvedBy: "b" }) };
    const offA = registry.register(a);
    expect(registry.resolve("x")?.decide?.({ face: "tool", tool: "t" })).toMatchObject({ reason: "a" });
    registry.register(b);
    expect(registry.resolve("x")?.posture?.({ face: "tool", tool: "t" })).toMatchObject({ reason: "b" });
    offA();
    expect(registry.resolve("x")?.posture?.({ face: "tool", tool: "t" })).toMatchObject({ reason: "b" });
  });

  it("形状门：空 id / decide 与 posture 皆缺 → throw；缺席 resolve = undefined", () => {
    const registry = createModeRegistry();
    expect(() => registry.register({ id: "", decide: () => undefined })).toThrow();
    expect(() => registry.register({ id: "y" } as never)).toThrow();
    expect(registry.resolve("nope")).toBeUndefined();
  });
});
