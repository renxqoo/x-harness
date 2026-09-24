// ask → confirm 弹窗载荷映射：summary 目标描述/建议规则/升级语境按在场裁剪进载荷
// （空 options 不发空壳）；确认条主文案材料自此随权限 ask 全量到帧。

import { describe, expect, test } from "vitest";
import type { AskPayload } from "@x-harness/permission";
import { confirmFieldsOf } from "../worker/ask-confirm-fields.ts";

const ASK: AskPayload = {
  tool: "edit",
  summary: "src/a.ts",
  reason: "edit-confirm: in-root write",
  options: ["once", "session", "project", "user"],
};

describe("confirmFieldsOf（AskPayload → confirm 弹窗载荷）", () => {
  test("目标描述 summary 原样进载荷（确认方一眼可见要改哪个文件）", () => {
    expect(confirmFieldsOf(ASK)).toEqual({
      tool: "edit",
      summary: "src/a.ts",
      reason: "edit-confirm: in-root write",
      options: ["once", "session", "project", "user"],
    });
  });

  test("可选面按在场裁剪：summary 缺席/空 options 不发空壳；建议规则与升级语境照进", () => {
    expect(
      confirmFieldsOf({
        tool: "bash",
        reason: "sandbox failure — retry outside the sandbox?",
        options: [],
        suggestedRule: "Bash(x:*):allow",
        escalate: { command: "mytool run", failureText: "Operation not permitted" },
      }),
    ).toEqual({
      tool: "bash",
      reason: "sandbox failure — retry outside the sandbox?",
      suggestedRule: "Bash(x:*):allow",
      escalate: { command: "mytool run", failureText: "Operation not permitted" },
    });
  });
});
