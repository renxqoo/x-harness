// 档位表（§4）：出厂五行形态、自定义行合并校验（保留名/重名/坏形态拒）、解析降级。

import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, mergeCustomProfiles, resolveProfile } from "../profiles.ts";
import { PROFILE_IDS } from "../types.ts";

describe("profiles 表", () => {
  it("出厂五行与 DESIGN §4.1 表一致", () => {
    expect(BUILTIN_PROFILES).toEqual([
      { id: "plan", askPolicy: "always", containment: "none", mutationPolicy: "plan-deny" },
      { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" },
      { id: "edit-confirm", askPolicy: "on-opaque", containment: "none", mutationPolicy: "confirm-all" },
      { id: "full", askPolicy: "never", containment: "none", mutationPolicy: "auto-in-root" },
      { id: "sandboxed-auto", askPolicy: "on-failure", containment: "fenced", mutationPolicy: "auto-in-root" },
    ]);
    expect(PROFILE_IDS).toEqual(["plan", "auto", "edit-confirm", "full", "sandboxed-auto"]);
  });

  it("resolveProfile：内置 > 自定义；未知降级 auto（垃圾不崩）", () => {
    const custom = [{ id: "strict", askPolicy: "always" as const, containment: "fenced" as const, mutationPolicy: "confirm-all" as const }];
    expect(resolveProfile("strict", custom).containment).toBe("fenced");
    expect(resolveProfile("auto", custom).askPolicy).toBe("on-opaque"); // 内核行压自定义重名
    expect(resolveProfile("no-such").id).toBe("auto");
  });

  it("mergeCustomProfiles：保留名拒 / 重名拒 / 坏形态拒（fail-closed）", () => {
    expect(mergeCustomProfiles([{ id: "full", askPolicy: "never" as const, containment: "none" as const, mutationPolicy: "auto-in-root" as const }])).toMatchObject({ ok: false });
    expect(mergeCustomProfiles([
      { id: "a", askPolicy: "always" as const, containment: "fenced" as const, mutationPolicy: "confirm-all" as const },
      { id: "a", askPolicy: "never" as const, containment: "none" as const, mutationPolicy: "auto-in-root" as const },
    ])).toMatchObject({ ok: false });
    expect(mergeCustomProfiles([{ id: "x", askPolicy: "bogus", containment: "none" as const, mutationPolicy: "auto-in-root" as const }])).toMatchObject({ ok: false });
    expect(mergeCustomProfiles([{ id: "strict", askPolicy: "always" as const, containment: "fenced" as const, mutationPolicy: "confirm-all" as const }])).toMatchObject({ ok: true });
  });
});
