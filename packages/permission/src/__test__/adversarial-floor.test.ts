// 对抗审查回归件（2026-09-28 红队/内核面——fail-open 洞修复后钉死）：
// 纯重定向宿主写保护（红队 #1）、建议串全盘形（内核 #3/R4）、edit-confirm 落账串（F2）、
// 习得闸单源（P1-4/R9）。迁自 .adversarial/kernel 与 .adversarial/rules 探针的可静态复现子集。

import { describe, expect, it } from "vitest";
import { adjudicateBash, decideFor, memoryBlocked, parseRules } from "../index.ts";
import { autoMode, editConfirmMode } from "@x-harness/permission-modes";
import type { PermissionProfile } from "../index.ts";

const ROOT = "/w/app";
const AUTO: PermissionProfile = { id: "auto", askPolicy: "on-opaque", containment: "none", mutationPolicy: "auto-in-root" };
const EDIT_CONFIRM: PermissionProfile = { id: "edit-confirm", askPolicy: "on-opaque", containment: "none", mutationPolicy: "confirm-all" };

const bash = (command: string, extra: { protectedWrite?: readonly string[]; rules?: never } = {}): ReturnType<typeof adjudicateBash> =>
  adjudicateBash({ command, rules: [], profile: AUTO, root: ROOT, extraRoots: [], ...(extra.protectedWrite !== undefined ? { protectedWrite: extra.protectedWrite } : {}) });

const postureOf = (mode: typeof autoMode | typeof editConfirmMode) => mode.posture;

describe("纯重定向宿主写保护（红队 #1——argv==0 段不逃执法）", () => {
  it("> .git/config（truncate 向量）→ deny redirect-write（含 >>/2> 形）", () => {
    for (const command of ["> .git/config", ">> .git/config", "2> .git/hooks/pre-commit"]) {
      const out = bash(command);
      expect(out.verdict, command).toBe("deny");
      expect(out.reason, command).toMatch(/^redirect-write:/);
    }
  });
  it("> protectedWrite 文件 → ask（保护写补偿面）；对照 argv 形同问", () => {
    const zero = bash("> /w/app/settings.json", { protectedWrite: ["/w/app/settings.json"] });
    expect(zero.verdict).toBe("ask");
    expect(bash("echo hi > /w/app/settings.json", { protectedWrite: ["/w/app/settings.json"] }).verdict).toBe("ask");
  });
  it("Danger(*) 万配对零 argv 段不再失明——重定向硬线先行", () => {
    const out = adjudicateBash({ command: "> .git/config", rules: [{ tool: "Danger", pattern: "*", verdict: "deny", nature: "handwritten", origin: "user" }], profile: AUTO, root: ROOT, extraRoots: [] });
    expect(out.verdict).toBe("deny"); // redirect-write 硬线（模式前）——argv 词元匹配不再唯一通道
  });
});

describe("顶层越根建议规则（内核 #3/R4——`//`+`**` ≡ 全盘授权的降级）", () => {
  const withPosture = (spec: { readonly kind: "Read" | "Write"; readonly path: string; readonly profile: PermissionProfile; readonly posture: typeof autoMode.posture }): ReturnType<typeof decideFor> =>
    decideFor({ tool: spec.kind === "Read" ? "read" : "write", kind: spec.kind, args: { path: spec.path }, userRules: [], sessionRules: [], profile: spec.profile, root: ROOT, extraRoots: [], ...(spec.posture !== undefined ? { postureDecide: spec.posture } : {}) });

  it("写 /outside.ts → 建议=精确路径规则（非全盘形）；读 /etc/passwd 同形", () => {
    const w = withPosture({ kind: "Write", path: "/outside.ts", profile: AUTO, posture: postureOf(autoMode) });
    expect(w.verdict).toBe("ask");
    expect(w.suggestedRule).toBe("Write(/outside.ts):allow");
    expect(withPosture({ kind: "Read", path: "/etc/passwd", profile: AUTO, posture: postureOf(autoMode) }).suggestedRule).toBe("Read(/etc/**):allow"); // 顶层文件才是精确形
  });
  it("正常父目录仍 dir/** 形", () => {
    expect(withPosture({ kind: "Read", path: "/elsewhere/a.ts", profile: AUTO, posture: postureOf(autoMode) }).suggestedRule).toBe("Read(/elsewhere/**):allow");
  });
  it("edit-confirm 建议串可解析落账（F2——旧缺 :allow 尾，批准+记忆档炸 internal）", () => {
    const out = withPosture({ kind: "Write", path: `${ROOT}/a.ts`, profile: EDIT_CONFIRM, posture: postureOf(editConfirmMode) });
    expect(out.verdict).toBe("ask");
    expect(out.suggestedRule).toBe(`Write(${ROOT}/**):allow`);
    expect(() => parseRules([out.suggestedRule ?? ""], "session")).not.toThrow();
  });
  it("edit-confirm pathAbsent 先于写问（F3——`write {}` 不再建议整根授权）", () => {
    const out = decideFor({ tool: "write", kind: "Write", args: {}, userRules: [], sessionRules: [], profile: EDIT_CONFIRM, root: ROOT, extraRoots: [], ...(postureOf(editConfirmMode) !== undefined ? { postureDecide: postureOf(editConfirmMode) } : {}) });
    expect(out).toMatchObject({ verdict: "ask", reason: "path-absent:write" });
    expect(out.suggestedRule).toBeUndefined();
  });
});

describe("习得闸（P1-4 单源——硬拒族头不习得）", () => {
  it("memoryBlocked：rm/chmod/env 头、前导空格形（R9）、畸形空头拒；普通/路径头放行", () => {
    expect(memoryBlocked("rm -rf build")).toBe(true);
    expect(memoryBlocked(" chmod:*")).toBe(true);
    expect(memoryBlocked("env VAR=1 ls")).toBe(true);
    expect(memoryBlocked("")).toBe(true);
    expect(memoryBlocked("git push")).toBe(false);
    expect(memoryBlocked("/w/app/**")).toBe(false);
  });
});
