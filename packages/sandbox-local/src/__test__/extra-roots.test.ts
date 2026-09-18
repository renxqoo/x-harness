// extraRoots 端到端（审查 B-2 处置证明）：permission 批准界外目录 → gate 放行（不再
// PATH_ESCAPES_ROOT）→ 工具真实读出 → fence.writable 并入（bash 重定向可写）→ 会话隔离。
// 全链装配 permission + sandbox + toolbox（darwin 真围栏；linux 腿 networkOff）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin, permissionBroker } from "@x-harness/permission";
import { createToolbox } from "@x-harness/toolbox";
import { createSandboxPlugin } from "../plugin.ts";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

const DARWIN = process.platform === "darwin";

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

  async function assemble(script: readonly ("allow" | "deny")[]): Promise<{ ctx: Context; unload: readonly Disposer[] }> {
    const b = broker(script);
    const ctx = createContext();
    const box = createToolbox({ root });
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionPlugin({ root }),
      createSandboxPlugin({ root, networkOff: true }), // 本用例专注文件面
      box.readPlugin,
      box.writePlugin,
      box.bashPlugin,
      b.plugin,
    ]);
    return { ctx, unload };
  }

  it("界外 read：批 → 放行并真实读出；二次零 ask；拒绝会话不借用", async () => {
    const { ctx, unload } = await assemble(["allow"]);
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
    const { ctx, unload } = await assemble(["deny"]);
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
    const { ctx, unload } = await assemble(["allow"]);
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
