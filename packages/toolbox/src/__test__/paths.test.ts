// 路径门测试（docs/TOOLBOX.md §1/§6）：越根（路径段边界）/symlink 逃逸/NUL/合法解析。

import { mkdirSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PathGate } from "../paths.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PathGate（docs/TOOLBOX.md §1）", () => {
  it("相对路径在 root 下解析；绝对路径 root 内放行", () => {
    const gate = new PathGate(root);
    // root 自身被归一到物理路径（macOS tmpdir /var→/private/var）——期望以 gate.root 为基准
    expect(gate.admit("src/a.ts")).toEqual({ ok: true, path: join(gate.root, "src/a.ts") });
    expect(gate.admit(join(root, "b.ts"))).toEqual({ ok: true, path: join(gate.root, "b.ts") });
    expect(gate.admit(root)).toEqual({ ok: true, path: gate.root });
  });

  it("..越根拒绝；绝对路径越根拒绝", () => {
    const gate = new PathGate(root);
    expect(gate.admit("../outside.txt").ok).toBe(false);
    expect(gate.admit("/etc/passwd").ok).toBe(false);
  });

  it("回归（my-agent BUG-06）：路径段边界——同前缀兄弟目录不放行", () => {
    const gate = new PathGate(root);
    const sibling = `${root}-sibling/secret.txt`;
    expect(gate.admit(sibling).ok).toBe(false); // /tmp/xh-gate-XXX-sibling 不在 /tmp/xh-gate-XXX 内
  });

  it("symlink 逃逸：根内 symlink 指向根外 → 拒（realpath 判定）", () => {
    const outside = mkdtempSync(join(tmpdir(), "xh-out-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      const gate = new PathGate(root);
      const admitted = gate.admit("escape/file.txt");
      expect(admitted.ok).toBe(false);
      if (!admitted.ok) expect(admitted.reason).toContain("PATH_ESCAPES_ROOT");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("symlink 正常：根内 symlink 指向根内 → 放行且返回词法路径（I/O 用词法）", () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const gate = new PathGate(root);
    const admitted = gate.admit("link/file.txt");
    expect(admitted).toEqual({ ok: true, path: join(gate.root, "link/file.txt") });
  });

  it("不存在路径：词法判定即够（无 realpath 前缀）", () => {
    const gate = new PathGate(root);
    expect(gate.admit("deep/new/file.txt")).toEqual({ ok: true, path: join(gate.root, "deep/new/file.txt") });
  });

  it("NUL 拒绝", () => {
    const gate = new PathGate(root);
    expect(gate.admit("a\u0000b").ok).toBe(false);
    expect(PathGate.hasNul("a\u0000b")).toBe(true);
    expect(PathGate.hasNul("ab")).toBe(false);
  });

  it("回归（症状：root=\"/\" 时一切路径被拒）：根为 / 时前缀不拼出 //，绝对路径全放行", () => {
    const whole = new PathGate("/");
    expect(whole.root).toBe("/");
    expect(whole.admit("/usr/lib")).toEqual({ ok: true, path: "/usr/lib" });
    expect(whole.admit("etc/hosts").ok).toBe(true); // 相对路径以 / 解析
    expect(whole.admit("/")).toEqual({ ok: true, path: "/" });
  });
});
