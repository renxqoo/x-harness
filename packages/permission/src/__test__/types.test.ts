// 类型契约锚（docs/EXEC-ENV.md §5 模式档）：MODE_KNOBS 词表封闭——深等值锁常量侧，
// 编译期穷尽断言锁类型侧（ModeKnob 扩档而词表漏跟 → never 赋值编译红 + 用例红）。

import { describe, expect, it } from "vitest";
import type { ModeKnob } from "../types.ts";
import { MODE_KNOBS } from "../types.ts";

// 编译期穷尽：词表漏档时 Exclude 产出非 never，条件类型坍缩为 never，赋值 true 报错
type UncoveredKnob = Exclude<ModeKnob, (typeof MODE_KNOBS)[number]>;
const exhaustive: UncoveredKnob extends never ? true : never = true;

describe("MODE_KNOBS 词表封闭", () => {
  it("深等于 plan|auto|full 三档（与 docs/EXEC-ENV.md §5 模式档闭集一致）", () => {
    expect(MODE_KNOBS).toEqual(["plan", "auto", "full"]);
  });

  it("编译期穷尽断言成立（词表覆盖 ModeKnob 全档）", () => {
    expect(exhaustive).toBe(true);
  });
});
