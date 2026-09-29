import { describe, expect, it } from "vitest";
import type { ProfileId } from "../types.ts";
import { PROFILE_IDS } from "../types.ts";

type UncoveredKnob = Exclude<ProfileId, (typeof PROFILE_IDS)[number]>;
const exhaustive: UncoveredKnob extends never ? true : never = true;

describe("PROFILE_IDS 词表封闭", () => {
  it("深等于五出厂档（与 DESIGN §4.1 表一致）", () => {
    expect(PROFILE_IDS).toEqual(["plan", "auto", "edit-confirm", "full", "sandboxed-auto"]);
  });

  it("exhaustive 锚在册", () => {
    expect(exhaustive).toBe(true);
  });
});
