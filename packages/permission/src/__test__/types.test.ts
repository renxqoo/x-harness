// 类型契约锚（docs/PERMISSION-V2-DESIGN.md §4）：PROFILE_IDS 词表封闭——深等值锁常量侧，
// 编译期穷尽断言锁类型侧（ProfileId 扩档而词表漏跟 → never 赋值编译红 + 用例红）。

import { describe, expect, it } from "vitest";
import type { ProfileId } from "../types.ts";
import { PROFILE_IDS } from "../types.ts";

// 编译期穷尽：词表漏档时 Exclude 产出非 never，条件类型坍缩为 never，赋值 true 报错
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
