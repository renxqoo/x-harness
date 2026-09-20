// extraRoots 端到端（审查 B-2 处置证明）：permission 批准界外目录 → gate 放行（不再
// PATH_ESCAPES_ROOT）→ 工具真实读出 → fence.writable 并入（bash 重定向可写）→ 会话隔离。
// 全链装配 permission + sandbox + 命令工具插件 tool-read/write/bash（darwin 真围栏；linux 腿 networkOff）。

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin, permissionBroker } from "@x-harness/permission";
import { ObservedRegistry, PathGate } from "@x-harness/tool-core";
import { createReadPlugin } from "@x-harness/tool-read";
import { createWritePlugin } from "@x-harness/tool-write";
import { createBashPlugin } from "@x-harness/tool-bash";
import { createSandboxPlugin } from "../plugin.ts";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

const DARWIN = process.platform === "darwin";

function broker(script: readonly ("allow" | "deny")[]): { plugin: Plugin; asks: string[] } {
  const asks: string[] = [];
  let at = 0;
  return {
    asks,
    plugin: {
      name: "scripted-broker",
      apply: (ctx: Context) =>
        ctx.provide(permissionBroker, {
          ask: async (input) => {
            asks.push(input.reason);
            const verdict = script[at] ?? "deny";
            at += 1;
            return verdict;
          },
        }),
    },
  };
}

/** 全链装配（root 由调用方管理——两个 describe 各自的 beforeEach 生命周期） */
async function assemble(root: string, script: readonly ("allow" | "deny")[], mode?: "plan" | "auto" | "full"): Promise<{ ctx: Context; unload: readonly Disposer[] }> {
  const b = broker(script);
  const ctx = createContext();
  const gate = new PathGate(root);
  const observed = new ObservedRegistry();
  const unload = await loadPlugins(ctx, [
    toolsPlugin,
    createPermissionPlugin({ root, ...(mode !== undefined ? { mode } : {}) }),
    createSandboxPlugin({ root, networkOff: true }), // 本用例专注文件面
    createReadPlugin({ gate, observed }),
    createWritePlugin({ gate, observed }),
    createBashPlugin({ gate }),
    b.plugin,
  ]);
  return { ctx, unload };
}

describe("extraRoots 全链（ask 批 → gate 放行 → fence 并入）", () => {
  let root = "";
  let outside = "";
  let outsideFile = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xh-xr-"));
    outside = mkdtempSync(join(tmpdir(), "xh-xr-out-"));
    outsideFile = join(outside, "note.txt");
    writeFileSync(outsideFile, "outside-content", "utf8");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const build = (script: readonly ("allow" | "deny")[]): Promise<{ ctx: Context; unload: readonly Disposer[] }> => assemble(root, script);

  it("界外 read：批 → 放行并真实读出；二次零 ask；拒绝会话不借用", async () => {
    const { ctx, unload } = await build(["allow"]);
    const reg = ctx.use(toolRegistry);
    const session = "sess-xr" as SessionId;
    const first = await reg.dispatch({
      callId: "c1",
      name: "read",
      args: { path: outsideFile },
      signal: new AbortController().signal,
      session,
    });
    expect(first.isError).toBeUndefined(); // gate 因 extraRoots 放行（不再 PATH_ESCAPES_ROOT）
    expect(first.content).toContain("outside-content"); // 真实读出（全链证明）
    const second = await reg.dispatch({
      callId: "c2",
      name: "read",
      args: { path: outsideFile },
      signal: new AbortController().signal,
      session,
    });
    expect(second.content).toContain("outside-content");
    const stranger = await reg.dispatch({
      callId: "c3",
      name: "read",
      args: { path: outsideFile },
      signal: new AbortController().signal,
      session: "sess-other" as SessionId,
    });
    expect(stranger.isError).toBe(true); // 异会话不借用（broker 脚本耗尽 → deny）
    for (const dispose of unload) await dispose();
  }, 20_000);

  it("拒批 → gate 维持拒绝（PATH_ESCAPES_ROOT 不因 ask 泄漏放行）", async () => {
    const { ctx, unload } = await build(["deny"]);
    const reg = ctx.use(toolRegistry);
    const out = await reg.dispatch({
      callId: "c1",
      name: "read",
      args: { path: outsideFile },
      signal: new AbortController().signal,
      session: "sess-d" as SessionId,
    });
    expect(out.isError).toBe(true);
    for (const dispose of unload) await dispose();
  }, 20_000);

  it("fence 并入 extraRoots：批后 bash 重定向可写界外授权目录（darwin 真围栏）", async () => {
    if (!DARWIN) return;
    const { ctx, unload } = await build(["allow"]);
    const reg = ctx.use(toolRegistry);
    const session = "sess-w" as SessionId;
    // 先批（read 建立授权根），再重定向写同目录
    await reg.dispatch({ callId: "c1", name: "read", args: { path: outsideFile }, signal: new AbortController().signal, session });
    const write = await reg.dispatch({
      callId: "c2",
      name: "bash",
      args: { command: `echo made > ${JSON.stringify(join(outside, "made.txt"))}`, timeout: 10_000 },
      signal: new AbortController().signal,
      session,
    });
    expect(write.isError).toBeUndefined(); // permission 重定向界内（extraRoots 并入 fence.writable）+ 内核剖面放行
    expect(write.content).toContain("[exit code: 0]");
    const check = await reg.dispatch({
      callId: "c3",
      name: "read",
      args: { path: join(outside, "made.txt") },
      signal: new AbortController().signal,
      session,
    });
    expect(check.content).toContain("made"); // 双向：写进去了且读得出（writable 真实生效）
    for (const dispose of unload) await dispose();
  }, 30_000);
});

describe("full 总括授权全链（docs/PERMISSION-FULL-UNRESTRICTED.md——围栏面界外用 home 下非 tmpdir 路径，区分 auto/full）", () => {
  let root = "";
  let homeOutside = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xh-full-"));
    homeOutside = mkdtempSync(join(homedir(), "xh-full-out-")); // 非 tmpdir：围栏 writable 恒含 tmpdir，home 下才可区分档位
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeOutside, { recursive: true, force: true });
  });

  it("full 档 bash 重定向写 home 下界外路径真写出（围栏面修复的行为证据 + SBPL subpath / 真跑）", async () => {
    if (!DARWIN) return; // linux bwrap 真跑归流水线环境（方案「不处理」表落档）
    const { ctx, unload } = await assemble(root, [], "full");
    const reg = ctx.use(toolRegistry);
    const target = join(homeOutside, "made-by-full.txt");
    const write = await reg.dispatch({
      callId: "cf1",
      name: "bash",
      args: { command: `echo full-made > ${JSON.stringify(target)}`, timeout: 10_000 },
      signal: new AbortController().signal,
      session: "sess-full" as SessionId,
    });
    expect(write.isError).toBeUndefined();
    expect(write.content).toContain("[exit code: 0]");
    expect(readFileSync(target, "utf8")).toContain("full-made"); // 真写出
    for (const dispose of unload) await dispose();
  }, 30_000);

  it("full 档 read 工具读 home 下界外文件真读出（工具面授权根 / 生效）", async () => {
    const { ctx, unload } = await assemble(root, [], "full");
    const reg = ctx.use(toolRegistry);
    const target = join(homeOutside, "note.txt");
    writeFileSync(target, "home-outside-content", "utf8");
    const out = await reg.dispatch({
      callId: "cf2",
      name: "read",
      args: { path: target },
      signal: new AbortController().signal,
      session: "sess-full" as SessionId,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("home-outside-content");
    for (const dispose of unload) await dispose();
  }, 20_000);

  it("full 档 denyRead 读拒现状锚：~/.ssh/** 规则拒压过 full（content 锚拒因来源——防 FS 错误伪装规则拒）", async () => {
    const { ctx, unload } = await assemble(root, [], "full");
    const reg = ctx.use(toolRegistry);
    const out = await reg.dispatch({
      callId: "cf3",
      name: "read",
      args: { path: join(homedir(), ".ssh", "id_rsa") },
      signal: new AbortController().signal,
      session: "sess-full" as SessionId,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("rule:~/.ssh/**"); // 拒因 = deny 规则（词法匹配先于 stat——文件存在与否不影响）
    for (const dispose of unload) await dispose();
  }, 20_000);

  it("full 档 denyRead 写放行现状锚（darwin rename 边界的显式快照）：denyRead 路径写不设防", async () => {
    if (!DARWIN) return; // linux tmpfs 遮挂拒写（分面口径）——darwin 腿锚「无拒写形态」边界
    const denyDir = mkdtempSync(join(homedir(), "xh-full-denyread-"));
    try {
      const ctx = createContext();
      const gate = new PathGate(root);
      const observed = new ObservedRegistry();
      const unload = await loadPlugins(ctx, [
        toolsPlugin,
        createPermissionPlugin({ root, mode: "full" }),
        createSandboxPlugin({ root, networkOff: true, denyReadExtra: [denyDir] }), // 经 fenceFor 进 denyRead 合成面
        createReadPlugin({ gate, observed }),
        createWritePlugin({ gate, observed }),
        createBashPlugin({ gate }),
      ]);
      const reg = ctx.use(toolRegistry);
      const target = join(denyDir, "made.txt");
      const write = await reg.dispatch({
        callId: "cd1",
        name: "bash",
        args: { command: `echo boundary > ${JSON.stringify(target)}`, timeout: 10_000 },
        signal: new AbortController().signal,
        session: "sess-full-dr" as SessionId,
      });
      expect(write.isError).toBeUndefined(); // 读拒在、写放行——darwin 内核无拒写形态（方案落档的已知边界）
      expect(readFileSync(target, "utf8")).toContain("boundary");
      for (const dispose of unload) await dispose();
    } finally {
      rmSync(denyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
