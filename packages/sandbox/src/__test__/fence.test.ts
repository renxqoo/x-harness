// fenceFor 合成矩阵（docs/SANDBOX.md §3）：真 GrantsRegistry（纯数据结构，非 mock）。

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GrantsRegistry } from "@x-harness/permission";
import { homedir } from "node:os";
import { CHILD_TMPDIR, DEFAULT_DENY_READ, fenceFor } from "../fence.ts";
import type { FenceBase } from "../fence.ts";

const base: FenceBase = { root: "/w/root" };
const SID = "s-1" as never;
const OTHER = "s-2" as never;

describe("fenceFor base 形态", () => {
  it("writable = root + tmpdir；denyRead 默认底线表；denyWrite = root/.git", () => {
    const f = fenceFor(base, new GrantsRegistry(), undefined);
    expect(f.writable).toEqual([resolve("/w/root"), tmpdir(), CHILD_TMPDIR]);
    expect(f.denyRead).toEqual(DEFAULT_DENY_READ);
    expect(f.denyWrite).toEqual([resolve("/w/root/.git")]);
    expect(f.allowedDomains).toEqual([]);
  });

  it("宿主附加并入：writableExtra/denyReadExtra/protectedPaths/allowedDomains；~/ 形态在 writable/denyWrite 展开为家目录绝对路径", () => {
    const f = fenceFor(
      { root: "/w/root", writableExtra: ["/x", "~/wx", "~"], denyReadExtra: ["~/.gnupg"], protectedPaths: ["/p", "~/px"], allowedDomains: ["a.test"] },
      new GrantsRegistry(),
      undefined,
    );
    expect(f.writable).toEqual([resolve("/w/root"), tmpdir(), CHILD_TMPDIR, "/x", resolve(homedir(), "wx"), homedir()]);
    expect(f.denyRead).toEqual([...DEFAULT_DENY_READ, "~/.gnupg"]); // denyRead 保留 ~ 原样交 srt 展开
    expect(f.denyWrite).toEqual([resolve("/w/root/.git"), "/p", resolve(homedir(), "px")]);
    expect(f.allowedDomains).toEqual(["a.test"]);
  });

  it("networkOff：allowedDomains 恒空（压过 unrestricted 与授权）", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    grants.recordDomain(SID, "a.test", "allow");
    const f = fenceFor({ root: "/w/root", networkOff: true }, grants, SID);
    expect(f.allowedDomains).toEqual([]);
  });
});

describe("fenceFor × grants", () => {
  it("extraRoots 并入 writable；域名授权并入 allowedDomains（deny 不入白名单）", () => {
    const grants = new GrantsRegistry();
    grants.addExtraRoot(SID, "/grant/a");
    grants.recordDomain(SID, "ok.test", "allow");
    grants.recordDomain(SID, "no.test", "deny");
    const f = fenceFor(base, grants, SID);
    expect(f.writable).toEqual([resolve("/w/root"), tmpdir(), CHILD_TMPDIR, "/grant/a"]);
    expect(f.allowedDomains).toEqual(["ok.test"]);
  });

  it("会话隔离：他域授权不并入本会话", () => {
    const grants = new GrantsRegistry();
    grants.recordDomain(OTHER, "other.test", "allow");
    expect(fenceFor(base, grants, SID).allowedDomains).toEqual([]);
  });

  it("unrestricted：writable 前置 / 与 allowedDomains=['*']（full 档全通）", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    const f = fenceFor(base, grants, SID);
    expect(f.writable[0]).toBe("/");
    expect(f.allowedDomains).toEqual(["*"]);
    // 底线不豁免：denyRead/denyWrite 仍在场
    expect(f.denyRead).toEqual(DEFAULT_DENY_READ);
    expect(f.denyWrite).toEqual([resolve("/w/root/.git")]);
  });

  it("rootOverride（worktree）：writable 以 override.dir 替换 root、.git 随新根、guard 子树批准被滤", () => {
    const grants = new GrantsRegistry();
    grants.setRootOverride(SID, "/wt/dir", "/w/root");
    grants.addExtraRoot(SID, "/w/root/inside");
    grants.addExtraRoot(SID, "/outside");
    const f = fenceFor(base, grants, SID);
    expect(f.writable).toEqual(["/wt/dir", tmpdir(), CHILD_TMPDIR, "/outside"]);
    expect(f.denyWrite).toEqual(["/wt/dir/.git"]);
  });

  it("rootOverride 会话在 unrestricted 下仍隔离（isUnrestricted 恒 false）", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    grants.setRootOverride(SID, "/wt/dir", "/w/root");
    const f = fenceFor(base, grants, SID);
    expect(f.writable[0]).toBe("/wt/dir");
    expect(f.allowedDomains).toEqual([]);
  });

  it("unrestricted 撤销（seal/切档）即时收回", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    expect(fenceFor(base, grants, SID).allowedDomains).toEqual(["*"]);
    grants.setUnrestricted(false);
    expect(fenceFor(base, grants, SID).allowedDomains).toEqual([]);
  });
});
