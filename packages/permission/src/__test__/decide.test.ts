import { describe, expect, it } from "vitest";
import { decideFor } from "../decide.ts";
import { resolveProfile } from "../profiles.ts";
const AUTO_PROFILE = resolveProfile("auto");


describe("控制类工具直通（isControlTool——todo 清单类，对齐 Codex is_builtin_control_tool）", () => {
  it("control 标记 → allow（control-tool），不落 unknown-tool ask——ask/broker 缺席场景同直通", () => {
    const out = decideFor({
      tool: "task_create",
      args: { subject: "x" },
      control: true,
      userRules: [],
      sessionRules: [],
      profile: AUTO_PROFILE,
      root: "/w",
      extraRoots: [],
    });
    expect(out).toEqual({ verdict: "allow", reason: "control tool", resolvedBy: "control-tool" });
  });

  it("无标记的未知工具仍 ask 兜底（安全面不放宽——只有显式声明放行）", () => {
    const out = decideFor({
      tool: "task_create",
      args: {},
      userRules: [],
      sessionRules: [],
      profile: AUTO_PROFILE,
      root: "/w",
      extraRoots: [],
    });
    expect(out).toMatchObject({ verdict: "ask", resolvedBy: "default:ask" });
  });
});
