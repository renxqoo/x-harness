import { describe, expect, it } from "vitest";
import { autoMode, editConfirmMode, fullMode, knobDecideOf, planDefaultMode, sandboxedAutoMode } from "../modes.ts";

describe("knobDecideOf 组合序（P1-2——收紧优先）", () => {
  it("never+none+收紧策略 → 收紧件（旧：fullMode 吞掉 plan-deny/confirm-all）", () => {
    expect(knobDecideOf({ askPolicy: "never", containment: "none", mutationPolicy: "plan-deny" })).toBe(planDefaultMode);
    expect(knobDecideOf({ askPolicy: "never", containment: "none", mutationPolicy: "confirm-all" })).toBe(editConfirmMode);
  });
  it("纯 full / sandboxed / auto 形不变", () => {
    expect(knobDecideOf({ askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" })).toBe(fullMode);
    expect(knobDecideOf({ askPolicy: "on-failure", containment: "fenced", mutationPolicy: "auto-in-root" })).toBe(sandboxedAutoMode);
    expect(knobDecideOf({ askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" })).toBe(autoMode);
  });
});

describe("profileRowValid 拒矛盾组合（permission 内核校验面——P1-2 第二道闸）", () => {
  it("never+收紧行拒收；正常行放行", async () => {
    const { profileRowValid } = await import("@x-harness/permission");
    expect(profileRowValid({ id: "x1", askPolicy: "never", containment: "none", mutationPolicy: "plan-deny" })).toBe(false);
    expect(profileRowValid({ id: "x1", askPolicy: "never", containment: "none", mutationPolicy: "confirm-all" })).toBe(false);
    expect(profileRowValid({ id: "x1", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" })).toBe(true);
    expect(profileRowValid({ id: "x1", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" })).toBe(true);
  });
});
