// Fence 合成（docs/EXEC-ENV.md §4/§6）：单一解析函数 base ∧ 会话授权——域名并集即时生效、
// networkOff、writable 归一（root+tmpdir+附加）、拒读表默认在场可加不可减。

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { GrantsRegistry } from "@x-harness/permission";
import { fenceFor, denyReadPaths } from "../fence.ts";
import type { SessionId } from "@x-harness/session";

const S = "sess-f" as SessionId;

describe("fenceFor（base ∧ grants 单一合成）", () => {
  it("writable = root+tmpdir+附加（realpath 归一）；denyRead 默认表在场可加", () => {
    const grants = new GrantsRegistry();
    const f = fenceFor({ root: "/tmp", writableExtra: ["/tmp/extra-cache"], denyReadExtra: ["~/secrets"] }, grants, S);
    expect(f.writable).toContain(tmpdir()); // 词法口径（物理双形在 seatbelt 剖面层展开）
    expect(f.writable.some((w) => w.endsWith("extra-cache"))).toBe(true);
    expect(f.denyRead).toContain("~/.ssh"); // 默认表（用户裁决②可加不可减）
    expect(f.denyRead).toContain("~/secrets"); // 宿主追加
  });

  it("网络：会话授权域名并入白名单（deny 不入）；networkOff 全断", () => {
    const grants = new GrantsRegistry();
    grants.recordDomain(S, "a.com", "allow");
    grants.recordDomain(S, "evil.com", "deny");
    const f = fenceFor({ root: "/tmp", allowedDomains: ["pre.dev"] }, grants, S);
    if (f.network === "off") throw new Error("expected allowlist");
    expect(f.network.allowedDomains).toContain("a.com"); // 会话授权并集
    expect(f.network.allowedDomains).not.toContain("evil.com"); // deny 不入白名单
    expect(f.network.allowedDomains).toContain("pre.dev"); // 宿主预授权会话无关直接并入
    const off = fenceFor({ root: "/tmp", networkOff: true }, grants, S);
    expect(off.network).toBe("off");
  });

  it("会话隔离：B 会话授权不进 A 会话 fence", () => {
    const grants = new GrantsRegistry();
    grants.recordDomain(S, "mine.com", "allow");
    const other = fenceFor({ root: "/tmp" }, grants, "sess-B" as SessionId);
    if (other.network === "off") throw new Error("expected allowlist");
    expect(other.network.allowedDomains).toEqual([]);
  });
});

describe("denyReadPaths（spawn 面遮挂目标展开）", () => {
  it("~ 展开到家目录绝对路径（含裸 ~ 形态与普通绝对形态）", () => {
    const f = fenceFor({ root: "/tmp", denyReadExtra: ["~", "/var/secure"] }, new GrantsRegistry(), undefined);
    const paths = denyReadPaths(f, "/Users/demo");
    expect(paths).toContain("/Users/demo/.ssh");
    expect(paths).toContain("/Users/demo/.aws");
    expect(paths).toContain("/Users/demo"); // 裸 ~ = 家目录整体
    expect(paths).toContain("/var/secure"); // 普通绝对形态原样
  });
});

describe("fenceFor 会话根替换（件13 接缝 6——worktree 隔离）", () => {
  it("override 在场：writable 换 worktree 根、protectedPaths 随之重算、原根子树 extraRoots 被过滤", () => {
    const g = new GrantsRegistry();
    g.setRootOverride(S, "/wt/wt-1", "/repo");
    g.addExtraRoot(S, "/repo/sub"); // 原根子树——过滤（防权限批准打穿隔离）
    g.addExtraRoot(S, "/other/area"); // 界外授权——保留
    const fence = fenceFor({ root: "/repo" }, g, S);
    expect(fence.writable).toContain("/wt/wt-1");
    expect(fence.writable).not.toContain("/repo");
    expect(fence.writable).toContain("/other/area");
    expect(fence.writable).not.toContain("/repo/sub");
    expect(fence.protectedPaths).toContain("/wt/wt-1/.git");
    expect(fence.protectedPaths).not.toContain("/repo/.git");
  });

  it("无 override：行为不变（原根 + tmpdir + 授权根）", () => {
    const g = new GrantsRegistry();
    g.addExtraRoot(S, "/repo/sub");
    const fence = fenceFor({ root: "/repo" }, g, S);
    expect(fence.writable).toContain("/repo");
    expect(fence.writable).toContain("/repo/sub");
    expect(fence.protectedPaths).toContain("/repo/.git");
  });
});

describe("fenceFor × unrestricted 总括（docs/PERMISSION-FULL-UNRESTRICTED.md）", () => {
  it("总括态：writable 并入全盘根 /（授权根经既有管道流入围栏合成）", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    const f = fenceFor({ root: "/w/app" }, grants, S);
    expect(f.writable).toContain("/");
    expect(f.denyRead).toContain("~/.ssh"); // 拒读底线不因总括消失
  });

  it("worktree 例外消费面：override + 总括 → writable 不含 / 且以 override.dir 为根（隔离压过总括在合成面成立）", () => {
    const grants = new GrantsRegistry();
    grants.setRootOverride(S, "/wt/wt-u", "/repo");
    grants.setUnrestricted(true);
    const f = fenceFor({ root: "/repo" }, grants, S);
    expect(f.writable).not.toContain("/");
    expect(f.writable).toContain("/wt/wt-u"); // override 根替换语义保持
    expect(f.writable.some((w) => w === "/repo" || w.startsWith("/repo/"))).toBe(false); // 原根不可达
  });
});
