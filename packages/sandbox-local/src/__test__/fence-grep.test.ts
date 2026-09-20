// 围栏下 grep 真跑（sysctl-read 窄许可的回归锚）：Rust std 的 page_size 经 sysctl
// hw.pagesize_compat，seatbelt deny default 拒绝后 guard page 以错误对齐 mmap → EINVAL →
// rg 立即 panic（darwin 25.5 实测）。auto 档界内 grep 经真围栏真出结果——剖面缺席该行时
// 症状为 SEARCH_FAILED rg SIGABRT。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createPermissionPlugin, permissionBroker } from "@x-harness/permission";
import { PathGate } from "@x-harness/tool-core";
import { createGrepPlugin } from "@x-harness/tool-grep";
import { createSandboxPlugin } from "../plugin.ts";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";

const DARWIN = process.platform === "darwin";

/** ask 记账 broker（脚本耗尽即 deny）——意外的 ask 会先红在 asks 断言 */
function auditingBroker(script: readonly ("allow" | "deny")[]): { plugin: Plugin; asks: string[] } {
  const asks: string[] = [];
  let at = 0;
  return {
    asks,
    plugin: {
      name: "auditing-broker",
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

describe("围栏下 grep 真跑（sysctl-read 窄许可——Rust std page_size 坑）", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xh-grep-fence-"));
    writeFileSync(join(root, "in.txt"), "FENCE-GREP-NEEDLE\n", "utf8");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!DARWIN)("auto 档界内 grep 经真围栏真出结果且零 ask（界内直通不弹审批）", async () => {
    // bwrap 无 syscall 拒绝面（mount-ns 隔离不拦 sysconf/auxv）——linux 真跑腿归流水线
    const b = auditingBroker([]); // 耗尽即 deny：意外 ask 只会让 dispatch 红而不是静默放行
    const ctx = createContext();
    const gate = new PathGate(root);
    const unload = await loadPlugins(ctx, [
      toolsPlugin,
      createPermissionPlugin({ root }), // auto 档（mode 缺省）
      createSandboxPlugin({ root, networkOff: true }),
      createGrepPlugin({ gate }),
      b.plugin,
    ]);
    const reg = ctx.use(toolRegistry);
    const out = await reg.dispatch({
      callId: "gf1",
      name: "grep",
      args: { pattern: "FENCE-GREP-NEEDLE", path: root },
      signal: new AbortController().signal,
      session: "sess-gf" as SessionId,
    });
    expect(out.isError).toBeUndefined(); // 剖面缺 sysctl-read 时的症状：SEARCH_FAILED rg SIGABRT
    expect(out.content).toContain("FENCE-GREP-NEEDLE");
    expect(out.content).toContain("in.txt");
    expect(b.asks).toHaveLength(0); // 界内 grep 直通——不弹审批
    for (const dispose of unload) await dispose();
  }, 30_000);
});
