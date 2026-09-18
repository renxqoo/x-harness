// Fence 合成（docs/EXEC-ENV.md §4/§6）：单一解析函数 base ∧ 会话授权——域名并集即时生效、
// networkOff、writable 归一（root+tmpdir+附加）、拒读表默认在场可加不可减。

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { GrantsRegistry } from "@x-harness/permission";
import { fenceFor, denyReadPaths } from "../fence.ts";
import type { SessionId } from "@x-harness/session";

const S = "sess-f" as SessionId;

describe("fenceFor（base ∧ grants 单一合成）", () => {
  it("writable = root+tmpdir+附加（realpath 归一）；denyRead 默认表在场可加", () => {
    const grants = new GrantsRegistry();
    const f = fenceFor({ root: "/tmp", writableExtra: ["/tmp/extra-cache"], denyReadExtra: ["~/secrets"] }, grants, S);
    expect(f.writable).toContain(realpathSync(tmpdir())); // 归一口径（/var→/private/var）
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
    expect(f.network.allowedDomains).not.toContain("pre.dev"); // allowedDomains 配置经 grants 预授权入正缓存（见 plugin）——fence 只看授权集
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
  it("~ 展开到家目录绝对路径", () => {
    const f = fenceFor({ root: "/tmp" }, new GrantsRegistry(), undefined);
    const paths = denyReadPaths(f, "/Users/demo");
    expect(paths).toContain("/Users/demo/.ssh");
    expect(paths).toContain("/Users/demo/.aws");
  });
});
