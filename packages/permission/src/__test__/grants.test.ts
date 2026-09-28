// 会话授权集（docs/EXEC-ENV.md §5）：键控隔离/域名正负缓存/单飞互斥（同域单问异域并行）/逐出/seal。

import { describe, expect, it } from "vitest";
import { GrantsRegistry } from "../grants.ts";
import type { SessionId } from "@x-harness/session";

const A = "sess-a" as SessionId;
const B = "sess-b" as SessionId;

describe("GrantsRegistry", () => {
  it("extraRoots 会话隔离：A 加的根 B 不可见；匿名桶独立", () => {
    const g = new GrantsRegistry();
    g.addExtraRoot(A, "/w/extra");
    expect(g.extraRootsOf(A)).toEqual(["/w/extra"]);
    expect(g.extraRootsOf(B)).toEqual([]);
    expect(g.extraRootsOf(undefined)).toEqual([]);
  });

  it("evict：会话终结逐出桶 + 迟到写入口全灭（红队 F5）", () => {
    const g = new GrantsRegistry();
    g.addExtraRoot(A, "/w/x");
    g.evict(A);
    expect(g.extraRootsOf(A)).toEqual([]);
    g.addExtraRoot(A, "/w/y"); // 迟到授权不复活
    g.addRule(A, { tool: "Read", pattern: "/x", verdict: "allow", origin: "session" });
    expect(g.extraRootsOf(A)).toEqual([]);
    expect(g.rulesOf(A)).toEqual([]);
  });
});

describe("rootOverride（件13 接缝 3——worktree 会话根替换）", () => {
  it("set/rootOverrideOf 回路；evict 连带清除", () => {
    const g = new GrantsRegistry();
    expect(g.rootOverrideOf(A)).toBeUndefined();
    g.setRootOverride(A, "/wt/agent-1", "/repo");
    expect(g.rootOverrideOf(A)).toEqual({ dir: "/wt/agent-1", guard: "/repo" });
    expect(g.rootOverrideOf(B)).toBeUndefined(); // 会话隔离
    g.evict(A);
    expect(g.rootOverrideOf(A)).toBeUndefined();
  });
});

describe("unrestricted 总括授权（docs/PERMISSION-FULL-UNRESTRICTED.md——full 档授权事实）", () => {
  it("缺省非总括：isUnrestricted 恒 false（回归）", () => {
    const g = new GrantsRegistry();
    expect(g.isUnrestricted(A)).toBe(false);
    expect(g.isUnrestricted(undefined)).toBe(false);
  });

  it("总括态：无 override 会话（含未建桶）extraRootsOf 深等于 [\"/\"]——吸收非并集", () => {
    const g = new GrantsRegistry();
    g.addExtraRoot(A, "/w/old-root");
    g.setUnrestricted(true);
    expect(g.extraRootsOf(A)).toEqual(["/"]); // 已有逐目录授权被吸收
    expect(g.extraRootsOf(B)).toEqual(["/"]); // 未建桶会话同
    expect(g.extraRootsOf(undefined)).toEqual(["/"]);
    expect(g.isUnrestricted(A)).toBe(true);
  });

  it("override 会话例外：总括不注入、逐目录授权原语义保留（防吞 worktree 批准回流链）", () => {
    const g = new GrantsRegistry();
    g.setRootOverride(A, "/wt/agent-1", "/repo");
    g.addExtraRoot(A, "/wt/agent-1/sub");
    g.setUnrestricted(true);
    expect(g.extraRootsOf(A)).toEqual(["/wt/agent-1/sub"]); // 逐目录读回，非 [] 非 ["/"]
    expect(g.isUnrestricted(A)).toBe(false);
    expect(g.extraRootsOf(B)).toEqual(["/"]); // 同一 registry 内两形态共存分叉
    expect(g.isUnrestricted(B)).toBe(true);
  });

  it("evict 不清总括旗标（进程级事实）：逐出后该会话重查仍 [\"/\"]", () => {
    const g = new GrantsRegistry();
    g.setUnrestricted(true);
    g.evict(A);
    expect(g.extraRootsOf(A)).toEqual(["/"]);
    expect(g.isUnrestricted(A)).toBe(true);
  });

  it("回归（收口审查 P1）：override 会话 evict 后总括不复活——仍非总括、extraRoots 归零（隔离事实进程级记忆）", () => {
    const g = new GrantsRegistry();
    g.setRootOverride(A, "/wt/agent-1", "/repo");
    g.setUnrestricted(true);
    g.evict(A); // 会话终结逐出桶（rootOverrideOf 随桶清除——既有语义）
    expect(g.rootOverrideOf(A)).toBeUndefined(); // 桶事实清除不变
    expect(g.isUnrestricted(A)).toBe(false); // 但总括例外仍成立——不复活 ["/"]
    expect(g.extraRootsOf(A)).toEqual([]);
    expect(g.extraRootsOf(B)).toEqual(["/"]); // 普通会话不受影响
  });

  it("seal 收回总括：拆卸后 isUnrestricted 恒 false（fail-closed 同向）", () => {
    const g = new GrantsRegistry();
    g.setUnrestricted(true);
    g.seal();
    expect(g.isUnrestricted(A)).toBe(false);
    expect(g.isUnrestricted(undefined)).toBe(false);
  });
});
