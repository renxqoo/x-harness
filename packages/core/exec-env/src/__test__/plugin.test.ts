// localEnvPlugin 装配测试：provide(execEnv) 可 use、root 归一、dispose 撤服务。

import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { createLocalEnvPlugin } from "../local/plugin.ts";
import { execEnv } from "../tokens.ts";
import type { ExecEnv } from "../types.ts";

describe("localEnvPlugin（docs/EXEC-ENV.md §0——装配即选择的缺省档）", () => {
  it("apply 后 execEnv 服务可解析：kind=local、root realpath 归一", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [createLocalEnvPlugin({ root: "/tmp" })]);
    const env = ctx.use(execEnv);
    expect(env.kind).toBe("local");
    // macOS /tmp → /private/tmp（词法 root 归一到物理路径）
    expect(env.root).toBe(await env.realpath("/tmp"));
    expect((env as ExecEnv).spawn).toBeTypeOf("function");
  });

  it("dispose 后服务不可见（tryUse undefined）", async () => {
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [createLocalEnvPlugin({ root: "/tmp" })]);
    expect(ctx.tryUse(execEnv)?.kind).toBe("local");
    for (const dispose of unload) await dispose();
    expect(ctx.tryUse(execEnv)).toBeUndefined();
  });
});
