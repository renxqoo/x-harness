// 执行指令分路（PERMISSION-V2 §6.1）：exec=direct 免包裹；contained/缺席=fail-safe 包裹；
// rootOverride 隔离会话恒包裹（U17）；unrestricted 总括直通。fenceSuspect 归因单点。

import { describe, expect, it } from "vitest";
import { GrantsRegistry } from "@x-harness/permission";
import { fenceFor } from "../fence.ts";
import { fenceSuspectOf } from "../fence-suspect.ts";

const ROOT = "/w/app";

describe("fenceFor（隔离标志）", () => {
  it("rootOverride 会话 isolated=true（U17——执行面据此恒包裹）；普通会话 false", () => {
    const grants = new GrantsRegistry();
    expect(fenceFor({ root: ROOT }, grants, undefined).isolated).toBe(false);
    grants.setRootOverride("s1" as never, "/w/worktree", ROOT);
    expect(fenceFor({ root: ROOT }, grants, "s1" as never).isolated).toBe(true);
  });

  it("unrestricted 会话 unfenced=true（full 总括——唯一 direct 覆写形态）", () => {
    const grants = new GrantsRegistry();
    grants.setUnrestricted(true);
    expect(fenceFor({ root: ROOT }, grants, undefined)).toMatchObject({ unfenced: true, isolated: false });
  });
});

describe("fenceSuspectOf（U14 归因单点）", () => {
  it("非零退出 + 签名命中（EPERM/Operation not permitted/Permission denied/sandbox）", () => {
    expect(fenceSuspectOf(1, "sh: cannot open: Operation not permitted")).toBe(true);
    expect(fenceSuspectOf(13, "bash: /x: Permission denied")).toBe(true);
    expect(fenceSuspectOf(1, "EPERM write")).toBe(true);
    expect(fenceSuspectOf(1, "sandbox denial: deny write")).toBe(true);
  });

  it("零退出/无签名/超时信号死亡不算（exitCode null=信号/超时形态）", () => {
    expect(fenceSuspectOf(0, "Operation not permitted")).toBe(false);
    expect(fenceSuspectOf(1, "syntax error near unexpected token")).toBe(false);
    expect(fenceSuspectOf(null, "Operation not permitted")).toBe(false);
  });
});
