// worker 模式全量：经 pluginManagerService 服务面驱动 bridge/install 的产品代码路径。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineEvent, defineService, loadPlugins } from "@x-harness/core";
import type { AnyToken } from "@x-harness/core";
import { createPluginManager } from "../plugin-manager.ts";
import { pluginManagerService } from "../types.ts";
import type { PluginAuditEntry, PluginManagerService } from "../types.ts";

const CORE_PATH = new URL("../../../core/context/src/index.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tick = defineEvent<{ v: number }>("pm-w-tick");
const db = defineService<{ query(sql: string): string }>("pm-w-db");

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function setup(options?: {
  tokens?: readonly AnyToken[];
  applyTimeoutMs?: number;
  runtimeTimeoutMs?: number;
}): Promise<{
  ctx: ReturnType<typeof createContext>;
  svc: PluginManagerService;
  root: string;
  auditLog: PluginAuditEntry[];
}> {
  const ctx = createContext();
  const root = await mkdtemp(join(tmpdir(), "pmw-"));
  tempDirs.push(root);
  const auditLog: PluginAuditEntry[] = [];
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
      audit: { append: async (entry) => { auditLog.push(entry); } },
    }),
  ]);
  return { ctx, svc: ctx.use(pluginManagerService), root, auditLog };
}

const alive = (ctx: ReturnType<typeof createContext>): void => {
  const probe = defineEvent<{ v: number }>("pm-w-alive");
  const heard: number[] = [];
  ctx.on(probe, ({ v }) => heard.push(v));
  ctx.emit(probe, { v: 1 });
  expect(heard).toEqual([1]);
  expect(() => ctx.effect(() => {})).not.toThrow();
};

/** 轮询等可观测信号落定（有界）——击杀收殓类断言不押注固定 sleep */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never met within timeout");
    await sleep(20);
  }
}

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
    await sleep(50); // 投递即忘——等 worker 侧处理
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
    // #5：失败留 failed 登记（对话迭代可见失败历史）
    const records = svc.list().filter((r) => r.name === "whang");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed" });
    await expect(svc.uninstall("whang")).resolves.toMatchObject({ ok: true }); // 显式清除
    expect(svc.list().filter((r) => r.name === "whang")).toHaveLength(0);
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

describe("worker 模式：审查修复回归", () => {
  it("apply 超时击杀收殓落定后 failed 登记仍存活（症状：击杀收殓抹掉失败历史，list 查无此插件）", async () => {
    const { svc, root, auditLog } = await setup({ applyTimeoutMs: 300 });
    const file = join(root, "spin2.ts");
    await writeFile(file, `export default { name: "spin2", apply: () => { while (true) {} } };`, "utf8");
    const result = await svc.install({ path: file });
    expect(result).toMatchObject({ ok: false });
    // 轮询可观测信号（killed 台账到达）等收殓真正落定——不押注固定 sleep 的时序侥幸
    const killedSpin2 = (entry: PluginAuditEntry): boolean =>
      entry.kind === "killed" && entry.plugin === "spin2";
    await waitFor(() => auditLog.some(killedSpin2), 5_000);
    await sleep(20); // killed 台账之后紧邻的 removeIfOwned 落定
    const records = svc.list().filter((r) => r.name === "spin2");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed" });
  });

  it("#1 replace 迭代：同 provide 的 v2 换 v1 成功（proceed 门消除冲突窗口）", async () => {
    const { svc, root, ctx } = await setup();
    const v1 = join(root, "iterv1.ts");
    const v2 = join(root, "iterv2.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(v1, `import { defineService } from "${CORE_PATH}";
export default { name: "iter", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-r-iter"), { v: () => 1 }); } };`);
    await wf(v2, `import { defineService } from "${CORE_PATH}";
export default { name: "iter", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-r-iter"), { v: () => 2 }); } };`);
    await expect(svc.install({ path: v1 })).resolves.toMatchObject({ ok: true });
    await expect(svc.install({ path: v2, replace: true })).resolves.toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-r-iter");
    if (token === undefined) throw new Error("token missing");
    expect(await (ctx.use(token as ReturnType<typeof defineService<{ v(): number }>>)).v()).toBe(2);
  });

  it("#2/#11 shutdown 同构：在飞 RPC 显式拒绝；卸载后重装不被旧计时器污染", async () => {
    const { svc, root, ctx } = await setup({ runtimeTimeoutMs: 700 });
    const f = join(root, "sw.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(f, `import { defineService } from "${CORE_PATH}";
export default { name: "sw", apply: (c) => { c.provide(defineService<{ slow(): Promise<void> }>("pm-r-slow"), { slow: () => new Promise(() => {}) }); } };`);
    await expect(svc.install({ path: f })).resolves.toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-r-slow");
    if (token === undefined) throw new Error("token missing");
    const inFlight = (ctx.use(token as ReturnType<typeof defineService<{ slow(): Promise<void> }>>)).slow();
    const uninstalled = svc.uninstall("sw");
    await expect(inFlight).rejects.toThrow(/shut down|killed/); // 在飞 RPC 显式结算
    await expect(uninstalled).resolves.toMatchObject({ ok: true });
    // 重装同名——旧 bridge 的 700ms 计时器到点不得删掉新登记
    await expect(svc.install({ path: f })).resolves.toMatchObject({ ok: true });
    await sleep(900);
    expect(svc.list().filter((r) => r.name === "sw")).toHaveLength(1); // 新登记存活
  });

  it("#4 worker 版本门：apiVersion 不匹配拒", async () => {
    const { svc, root } = await setup();
    const f = join(root, "ver.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(f, `export default { name: "ver", apiVersion: 99, apply: () => {} };`);
    const result = await svc.install({ path: f });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("apiVersion");
  });

  it("#3 serial 监听拒装（worker 收窄 emit-only）", async () => {
    const { svc, root } = await setup();
    const f = join(root, "ser.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(f, `import { defineSerial } from "${CORE_PATH}";
export default { name: "ser", apply: (c) => { c.on(defineSerial<{ s: string }>("pm-r-any"), () => {}); } };`);
    const result = await svc.install({ path: f });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("serial listener not supported");
  });

  it("#9 worker 运行期监听器错误回流 errors()", async () => {
    const { svc, root, ctx } = await setup();
    const f = join(root, "noisy.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(f, `import { defineEvent } from "${CORE_PATH}";
export default { name: "wnoise", apply: (c) => { c.on(defineEvent<{ v: number }>("pm-w-tick"), () => { throw new Error("worker noise"); }); } };`);
    await expect(svc.install({ path: f })).resolves.toMatchObject({ ok: true });
    ctx.emit(tick, { v: 1 });
    await sleep(150); // 投递即忘 + worker 回流
    const errors = svc.errors("wnoise");
    expect(errors.some((e) => e.message.includes("worker noise"))).toBe(true);
    expect(errors.every((e) => e.plugin === "wnoise")).toBe(true); // 归属正确
  });

  it("#10 worker waitFor 平台服务：晚到服务停靠后解析为异步代理", async () => {
    const lateDb = defineService<{ query(sql: string): string }>("pm-r-late-db");
    const { svc, root, ctx } = await setup({ tokens: [tick, db, lateDb] });
    const f = join(root, "waiter.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(f, `import { defineService } from "${CORE_PATH}";
export default {
  name: "waiter",
  apply: async (c) => {
    const db = await c.waitFor(defineService<{ query(sql: string): string }>("pm-r-late-db"));
    c.provide(defineService<{ run(sql: string): Promise<string> }>("pm-r-run"), { run: async (sql) => db.query(sql) });
  },
};`);
    const installed = svc.install({ path: f }); // apply 停靠在 waitFor（late-db 未提供）
    await sleep(150);
    expect(svc.list().filter((r) => r.name === "waiter" && r.status === "active")).toHaveLength(0); // 仍停靠
    ctx.provide(lateDb, { query: (sql) => `late(${sql})` }); // 晚到
    const settled = await installed;
    expect(settled).toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-r-run");
    if (token === undefined) throw new Error("token missing");
    expect(
      await (ctx.use(token as ReturnType<typeof defineService<{ run(sql: string): Promise<string> }>>)).run("sel"),
    ).toBe("late(sel)");
  });
});

describe("worker 模式：e2e 批次审查修复回归", () => {
  it("同名重复安装被拒 → 在运行老插件的登记不被新桥击杀误删（症状：被拒后老插件变僵尸不可卸载）", async () => {
    const { svc, root, auditLog } = await setup();
    const incumbent = join(root, "dup-a.ts");
    const challenger = join(root, "dup-b.ts");
    await writeFile(incumbent, `import { defineService } from "${CORE_PATH}";
export default { name: "dup", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-w-dup"), { v: () => 1 }); } };`);
    await writeFile(challenger, `import { defineService } from "${CORE_PATH}";
export default { name: "dup", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-w-dup"), { v: () => 2 }); } };`);
    await expect(svc.install({ path: incumbent })).resolves.toMatchObject({ ok: true });
    await expect(svc.install({ path: challenger })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("use replace"),
    });
    // 等新桥击杀收殓真正落定（killed 台账），再断言老插件安然无恙
    const killedDuplicate = (entry: PluginAuditEntry): boolean =>
      entry.kind === "killed" && (entry.detail ?? "").includes("duplicate");
    await waitFor(() => auditLog.some(killedDuplicate), 5_000);
    await sleep(20);
    expect(svc.list().filter((r) => r.name === "dup")).toMatchObject([{ status: "active", mode: "worker" }]);
    await expect(svc.uninstall("dup")).resolves.toMatchObject({ ok: true }); // 仍可正常卸载
    expect(svc.serviceToken("pm-w-dup")).toBeUndefined();
  });

  it("同路径改写内容后 replace 重装见到新模块（worker 每装全新注册表——去 bust 后的新鲜度回归）", async () => {
    const { svc, root, ctx } = await setup();
    const file = join(root, "iterpath.ts");
    await writeFile(file, `import { defineService } from "${CORE_PATH}";
export default { name: "iterp", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-w-iterp"), { v: () => 1 }); } };`);
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    await writeFile(file, `import { defineService } from "${CORE_PATH}";
export default { name: "iterp", apply: (c) => { c.provide(defineService<{ v(): number }>("pm-w-iterp"), { v: () => 99 }); } };`);
    await expect(svc.install({ path: file, replace: true })).resolves.toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-w-iterp");
    if (token === undefined) throw new Error("token missing");
    expect(await (ctx.use(token as ReturnType<typeof defineService<{ v(): number }>>)).v()).toBe(99);
  });
});
