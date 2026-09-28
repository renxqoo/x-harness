// 范围型读回归件（R2/R8——grep 目录搜索绕拒读基线的修复）：
// ToolDefinition.readsSubtree 谓词 → DecideInput.pathScope → 内核子树判定
//（有锚相交 deny / 无锚 ask+范围记忆 / 文件目标直读规则 / 缺省 path=root 合法搜索）。

import { describe, expect, it } from "vitest";
import { decideFor } from "../index.ts";
import { autoMode } from "@x-harness/permission-modes";
import type { PermissionProfile } from "../index.ts";

const ROOT = "/w/app";
const AUTO: PermissionProfile = { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" };
const home = process.env.HOME ?? "/home/x";

const grep = (args: { readonly path?: unknown; readonly pattern?: unknown }, pathScope = true): ReturnType<typeof decideFor> =>
  decideFor({ tool: "grep", kind: "Read", ...(pathScope ? { pathScope: true } : {}), args, userRules: [], sessionRules: [], profile: AUTO, root: ROOT, extraRoots: [], ...(autoMode.posture !== undefined ? { postureDecide: autoMode.posture } : {}) });

describe("范围型读：子树拒读判定（R2——.adversarial/rules/04+09 迁移）", () => {
  it("搜索 ~/.ssh（有锚相交）→ deny（旧：目录参数永不命中文件 glob 直通）", () => {
    const out = grep({ pattern: "x", path: `${home}/.ssh` });
    expect(out).toMatchObject({ verdict: "deny" });
    expect(out.reason).toContain("~/.ssh");
  });
  it("搜索 ~（覆盖 ~/.ssh 树）→ deny；搜索 /etc（不相交）→ 无锚底线 ask + 范围记忆建议", () => {
    expect(grep({ pattern: "x", path: home }).verdict).toBe("deny");
    const etc = grep({ pattern: "x", path: "/etc" });
    expect(etc).toMatchObject({ verdict: "ask", resolvedBy: "scope-deny" });
    expect(etc.suggestedRule).toBe("Read(/etc):allow");
    expect(etc.memorizable).toBe(true);
  });
  it("习得范围规则免问：Read(/etc):allow 落账后同范围搜索 allow", () => {
    const learned = [{ tool: "Read" as const, pattern: "/etc", verdict: "allow" as const, nature: "grant" as const, origin: "session" as const }];
    const out = decideFor({ tool: "grep", kind: "Read", pathScope: true, args: { pattern: "x", path: "/etc" }, userRules: [], sessionRules: learned, profile: AUTO, root: ROOT, extraRoots: [], ...(autoMode.posture !== undefined ? { postureDecide: autoMode.posture } : {}) });
    expect(out).toMatchObject({ verdict: "allow", reason: "rule:/etc" });
  });
  it("文件目标（带扩展名）不做范围判定——直读规则面（full/规则照常）", () => {
    const file = grep({ pattern: "x", path: "/etc/sysctl.conf" }, false); // 谓词形：扩展名目标非范围
    expect(file).not.toMatchObject({ resolvedBy: "scope-deny" });
  });
  it("缺省 path = 以 root 为范围的合法搜索（R8——旧恒 path-absent 问）；.env 族根集内不再触发范围 ask（2026-09-28 裁决：项目本地配置可读）", () => {
    const out = grep({ pattern: "x" });
    expect(out).not.toMatchObject({ reason: "path-absent:grep" });
    expect(out.verdict).toBe("allow"); // 根集内搜索——无锚 .env 底线不再适用
  });
  it("范围在根集外：无锚 .env 底线仍触发范围 ask（凭据收割面拒止）", () => {
    const out = grep({ pattern: "x", path: "/etc" });
    expect(out.verdict).toBe("ask");
    expect(out.reason).toContain("scope-deny");
  });
});
