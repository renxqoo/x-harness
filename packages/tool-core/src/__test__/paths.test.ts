// 路径门测试（docs/TOOLBOX.md §1/§6 + docs/EXEC-ENV.md §3）：越根（路径段边界）/symlink 逃逸/
// NUL/合法解析。物理判定经注入的 env.realpath（单源在 exec-env）——测试注入 realpathDeep 包装。

import { mkdirSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { realpathDeep } from "@x-harness/exec-env";
import { PathGate, admitSession } from "../paths.ts";
import type { RealpathFn } from "../paths.ts";

let root: string;
const rp: RealpathFn = async (p) => realpathDeep(p);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("PathGate（docs/TOOLBOX.md §1 + EXEC-ENV.md §3）", () => {
  it("相对路径在 root 下解析；绝对路径 root 内放行", async () => {
    const gate = new PathGate(root);
    // root 自身被归一到物理路径（macOS tmpdir /var→/private/var）——期望以 gate.root 为基准
    expect(await gate.admit("src/a.ts", rp)).toEqual({ ok: true, path: join(gate.root, "src/a.ts") });
    expect(await gate.admit(join(root, "b.ts"), rp)).toEqual({ ok: true, path: join(gate.root, "b.ts") });
    expect(await gate.admit(root, rp)).toEqual({ ok: true, path: gate.root });
  });

  it("..越根拒绝；绝对路径越根拒绝", async () => {
    const gate = new PathGate(root);
    expect((await gate.admit("../outside.txt", rp)).ok).toBe(false);
    expect((await gate.admit("/etc/passwd", rp)).ok).toBe(false);
  });

  it("回归（my-agent BUG-06）：路径段边界——同前缀兄弟目录不放行", async () => {
    const gate = new PathGate(root);
    const sibling = `${root}-sibling/secret.txt`;
    expect((await gate.admit(sibling, rp)).ok).toBe(false); // /tmp/xh-gate-XXX-sibling 不在 /tmp/xh-gate-XXX 内
  });

  it("symlink 逃逸：根内 symlink 指向根外 → 拒（realpath 判定）", async () => {
    const outside = mkdtempSync(join(tmpdir(), "xh-out-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      const gate = new PathGate(root);
      const admitted = await gate.admit("escape/file.txt", rp);
      expect(admitted.ok).toBe(false);
      if (!admitted.ok) expect(admitted.reason).toContain("PATH_ESCAPES_ROOT");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("symlink 正常：根内 symlink 指向根内 → 放行且返回词法路径（I/O 用词法）", async () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const gate = new PathGate(root);
    const admitted = await gate.admit("link/file.txt", rp);
    expect(admitted).toEqual({ ok: true, path: join(gate.root, "link/file.txt") });
  });

  it("不存在路径：词法判定即够（无 realpath 前缀）", async () => {
    const gate = new PathGate(root);
    expect(await gate.admit("deep/new/file.txt", rp)).toEqual({ ok: true, path: join(gate.root, "deep/new/file.txt") });
  });

  it("NUL 拒绝", async () => {
    const gate = new PathGate(root);
    expect((await gate.admit("a\u0000b", rp)).ok).toBe(false);
    expect(PathGate.hasNul("a\u0000b")).toBe(true);
    expect(PathGate.hasNul("ab")).toBe(false);
  });

  it("回归（症状：root=\"/\" 时一切路径被拒）：根为 / 时前缀不拼出 //，绝对路径全放行", async () => {
    const whole = new PathGate("/");
    expect(whole.root).toBe("/");
    expect(await whole.admit("/usr/lib", rp)).toEqual({ ok: true, path: "/usr/lib" });
    expect((await whole.admit("etc/hosts", rp)).ok).toBe(true); // 相对路径以 / 解析
    expect(await whole.admit("/", rp)).toEqual({ ok: true, path: "/" });
  });
});

describe("admitSession 会话根替换（件13 接缝 4——worktree 真隔离）", () => {
  it("override 在场：worktree 路径放行、原根不可达、原根子树 extraRoots 被过滤、界外授权保留", async () => {
    const repo = mkdtempSync(join(tmpdir(), "xh-ov-repo-"));
    const wt = mkdtempSync(join(tmpdir(), "xh-ov-wt-"));
    const gate = new PathGate(repo);
    const rp = async (p: string) => p;
    const overrideOf = () => ({ dir: wt, guard: repo });
    const extraRootsOf = () => [join(repo, "sub"), join(tmpdir(), "xh-ov-extra-")];
    const toWT = await admitSession({ gate, realpath: rp, session: undefined, extraRootsOf, rootOverrideOf: overrideOf, target: join(wt, "file.ts") });
    expect(toWT.ok).toBe(true); // worktree 内放行
    const toRepo = await admitSession({ gate, realpath: rp, session: undefined, extraRootsOf, rootOverrideOf: overrideOf, target: join(repo, "secret.ts") });
    expect(toRepo.ok).toBe(false); // 原根不可达
    const viaGuarded = await admitSession({ gate, realpath: rp, session: undefined, extraRootsOf, rootOverrideOf: overrideOf, target: join(repo, "sub", "x.ts") });
    expect(viaGuarded.ok).toBe(false); // 原根子树授权被过滤
    const viaExtra = await admitSession({ gate, realpath: rp, session: undefined, extraRootsOf, rootOverrideOf: overrideOf, target: join(tmpdir(), "xh-ov-extra-", "y.ts") });
    expect(viaExtra.ok).toBe(true); // 界外授权保留
  });
});
