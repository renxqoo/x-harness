// worker 模式全量：经 pluginManagerService 服务面驱动 bridge/install 的产品代码路径。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineEvent, defineService, loadPlugins } from "@x-harness/core";
import type { AnyToken } from "@x-harness/core";
import { createPluginManager } from "../plugin-manager.ts";
import { pluginManagerService } from "../types.ts";
import type { PluginManagerService } from "../types.ts";

const CORE_PATH = new URL("../../../core/src/index.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tick = defineEvent<{ v: number }>("pm-w-tick");
const db = defineService<{ query(sql: string): string }>("pm-w-db");

async function setup(options?: {
  tokens?: readonly AnyToken[];
  applyTimeoutMs?: number;
  runtimeTimeoutMs?: number;
}): Promise<{ ctx: ReturnType<typeof createContext>; svc: PluginManagerService; root: string }> {
  const ctx = createContext();
  const root = await mkdtemp(join(tmpdir(), "pmw-"));
  tempDirs.push(root);
  ctx.provide(db, { query: (sql) => `rows(${sql})` });
  await loadPlugins(ctx, [
    createPluginManager({
      ctx,
      roots: [root],
      approveInstall: () => true,
      mode: "worker",
      tokens: options?.tokens ?? [tick, db],
      applyTimeoutMs: options?.applyTimeoutMs ?? 10_000,
      runtimeTimeoutMs: options?.runtimeTimeoutMs ?? 5_000,
      audit: { append: async () => {} },
    }),
  ]);
  return { ctx, svc: ctx.use(pluginManagerService), root };
}

const alive = (ctx: ReturnType<typeof createContext>): void => {
  const probe = defineEvent<{ v: number }>("pm-w-alive");
  const heard: number[] = [];
  ctx.on(probe, ({ v }) => heard.push(v));
  ctx.emit(probe, { v: 1 });
  expect(heard).toEqual([1]);
  expect(() => ctx.effect(() => {})).not.toThrow();
};

describe("worker 模式：完整闭环", () => {
  it("install → 服务代理（平台 use → RPC）→ 事件投递 → worker 用平台服务", async () => {
    const { svc, root, ctx } = await setup();
    const file = join(root, "full.ts");
    await writeFile(
      file,
      `import { defineEvent, defineService } from "${CORE_PATH}";
export const counter = defineService<{ getN(): number; bump(): void; viaDb(sql: string): Promise<string> }>("pm-w-counter");
export default {
  name: "wfull",
  apply: (c) => {
    let n = 0;
    const db = c.use(defineService<{ query(sql: string): string }>("pm-w-db")); // 平台服务经 svc-call
    c.provide(counter, {
      getN: () => n,
      bump: () => { n += 1; },
      viaDb: async (sql: string) => db.query(sql),
    });
    c.on(defineEvent<{ v: number }>("pm-w-tick"), () => { n += 10; });
  },
};
`,
      "utf8",
    );
    const installed = await svc.install({ path: file });
    expect(installed).toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-w-counter");
    if (token === undefined) throw new Error("bridged token missing");
    const counter = ctx.use(token as ReturnType<typeof defineService<{ getN(): number; bump(): void; viaDb(sql: string): Promise<string> }>>);
    expect(await counter.viaDb("select 1")).toBe("rows(select 1)"); // worker → 平台服务 RPC
    ctx.emit(tick, { v: 1 }); // 平台 → worker 事件投递
    await new Promise((r) => setTimeout(r, 50)); // 投递即忘——等 worker 侧处理
    expect(await counter.getN()).toBe(10);
  });

  it("apply 死循环 → 超时击杀 → 装载失败、平台存活", async () => {
    const { svc, root, ctx } = await setup({ applyTimeoutMs: 400 });
    const file = join(root, "hang.ts");
    await writeFile(file, `export default { name: "whang", apply: () => { while (true) {} } };`, "utf8");
    const result = await svc.install({ path: file });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("apply timeout");
    alive(ctx);
    expect((await svc.list())).toHaveLength(0);
  });

  it("运行期死循环 → RPC 超时击杀 → 登记清除、平台存活", async () => {
    const { svc, root, ctx } = await setup({ runtimeTimeoutMs: 400 });
    const file = join(root, "hangy.ts");
    await writeFile(
      file,
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "whangy",
  apply: (c) => {
    c.provide(defineService<{ slow(): Promise<void> }>("pm-w-slow"), {
      slow: () => new Promise(() => { while (true) {} }),
    });
  },
};
`,
      "utf8",
    );
    const installed = await svc.install({ path: file });
    expect(installed).toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-w-slow");
    if (token === undefined) throw new Error("token missing");
    const proxy = ctx.use(token as ReturnType<typeof defineService<{ slow(): Promise<void> }>>);
    await expect(proxy.slow()).rejects.toThrow(/timeout|killed/);
    alive(ctx);
    expect(svc.list().filter((r) => r.name === "whangy")).toHaveLength(0); // 击杀后登记清除
  });

  it("waterfall 监听 → 装载拒（worker 模式约束）", async () => {
    const { svc, root } = await setup();
    const wf = defineEvent<{ v: number }>("pm-w-wf-proxy") as never as { readonly mode: "waterfall" };
    void wf;
    const file = join(root, "wf.ts");
    await writeFile(
      file,
      `import { defineWaterfall } from "${CORE_PATH}";
export default {
  name: "wwf",
  apply: (c) => { c.on(defineWaterfall<number, number>("any-wf"), async (i, next) => next(i)); },
};
`,
      "utf8",
    );
    const result = await svc.install({ path: file });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("waterfall");
  });

  it("未注册 token 监听 → 装载拒", async () => {
    const { svc, root } = await setup({ tokens: [] }); // 不给任何自定义 token
    const file = join(root, "ghost.ts");
    await writeFile(
      file,
      `import { defineEvent } from "${CORE_PATH}";
export default {
  name: "wghost",
  apply: (c) => { c.on(defineEvent<{ v: number }>("nowhere-token"), () => {}); },
};
`,
      "utf8",
    );
    const result = await svc.install({ path: file });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("unregistered token");
  });

  it("uninstall → shutdown → 登记清除", async () => {
    const { svc, root } = await setup();
    const file = join(root, "quiet.ts");
    await writeFile(
      file,
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "wquiet",
  apply: (c) => { c.provide(defineService<{ n: number }>("pm-w-quiet-svc"), { n: 1 }); },
};
`,
      "utf8",
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    expect(svc.serviceToken("pm-w-quiet-svc")).toBeDefined();
    await expect(svc.uninstall("wquiet")).resolves.toMatchObject({ ok: true });
    expect(svc.list().filter((r) => r.name === "wquiet")).toHaveLength(0);
    expect(svc.serviceToken("pm-w-quiet-svc")).toBeUndefined(); // 桥注册随 teardown 移除
  });
});
