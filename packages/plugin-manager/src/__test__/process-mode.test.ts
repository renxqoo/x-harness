// plugin-manager 全量测试：process 模式（真实文件 + 注入 loader 的校验面）。
// 平台存活断言贯穿所有失败路径（验收清单锚点）。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContext,
  defineEvent,
  defineGuard,
  defineService,
  defineWaterfall,
  loadPlugins,
  pluginEvent,
} from "@x-harness/core";
import { createPluginManager } from "../plugin-manager.ts";
import { pluginManagerService } from "../types.ts";
import type { PluginManagerService } from "../types.ts";

const CORE_PATH = new URL("../../../core/src/index.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writePlugin(root: string, name: string, source: string): Promise<string> {
  const file = join(root, `${name}.ts`);
  await writeFile(file, source, "utf8");
  return file;
}

async function setup(options?: {
  approve?: (path: string) => boolean;
}): Promise<{ ctx: ReturnType<typeof createContext>; svc: PluginManagerService; root: string }> {
  const ctx = createContext({ onListenerError: () => {} }); // 安静 sink：预期错误隔离不刷屏
  const root = await makeRoot();
  await loadPlugins(ctx, [
    createPluginManager({
      ctx,
      roots: [root],
      approveInstall: options?.approve ? () => true : undefined,
      audit: { append: async () => {} },
    }),
  ]);
  return { ctx, svc: ctx.use(pluginManagerService), root };
}

const alive = (ctx: ReturnType<typeof createContext>): (() => void) => {
  const tick = defineEvent<{ v: number }>("pm-alive-check");
  const heard: number[] = [];
  ctx.on(tick, ({ v }) => heard.push(v));
  return () => {
    ctx.emit(tick, { v: 1 });
    expect(heard).toEqual([1]);
    expect(() => ctx.effect(() => {})).not.toThrow();
  };
};

describe("process 模式：门与校验", () => {
  it("roots 越界拒（相对路径逃逸 + 绝对路径在外均拒）", async () => {
    const { svc } = await setup({ approve: () => true });
    const escape = await svc.install({ path: "../../etc/passwd" });
    expect(escape).toMatchObject({ ok: false });
    expect(escape.ok === false && escape.reason).toContain("outside roots");
    await expect(svc.install({ path: "/etc/passwd" })).resolves.toMatchObject({ ok: false });
  });

  it("审批缺省拒；放行后可装", async () => {
    const { svc, root } = await setup(); // 无 approve → 缺省拒
    const file = await writePlugin(root, "ok", `export default { name: "ok", apply: () => {} };`);
    const denied = await svc.install({ path: file });
    expect(denied).toMatchObject({ ok: false });
    expect(denied.ok === false && denied.reason).toContain("approval gate");

    const ctx2 = createContext();
    const root2 = await makeRoot();
    await loadPlugins(ctx2, [
      createPluginManager({ ctx: ctx2, roots: [root2], approveInstall: () => true, audit: { append: async () => {} } }),
    ]);
    const ok = await ctx2.use(pluginManagerService).install({ path: await writePlugin(root2, "ok2", `export default { name: "ok2", apply: () => {} };`) });
    expect(ok).toMatchObject({ ok: true });
  });

  it("形状校验：无 default / 非 Plugin / 缺 name / 缺 apply 均拒", async () => {
    const { svc, root } = await setup({ approve: () => true });
    const cases: Array<[string, string]> = [
      ["bad1", `export const x = 1;`],
      ["bad2", `export default { foo: 1 };`],
      ["bad3", `export default { apply: () => {} };`],
      ["bad4", `export default { name: "x" };`],
    ];
    for (const [name, source] of cases) {
      const result = await svc.install({ path: await writePlugin(root, name, source) });
      expect(result.ok, name).toBe(false);
    }
    expect((await svc.errors()).length).toBeGreaterThanOrEqual(4);
  });

  it("版本门：apiVersion 不匹配拒、匹配放行", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const bad = await writePlugin(root, "vb", `export default { name: "vb", apiVersion: 99, apply: () => {} };`);
    const rejected = await svc.install({ path: bad });
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected.ok === false && rejected.reason).toContain("apiVersion");
    const good = await writePlugin(root, "vg", `export default { name: "vg", apiVersion: 1, apply: () => {} };`);
    await expect(svc.install({ path: good })).resolves.toMatchObject({ ok: true });
    alive(ctx)();
  });
});

describe("process 模式：隔离装载与迭代", () => {
  it("happy path：服务/监听立即生效（落位 root——平台可见）", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "translate",
      `import { defineEvent, defineService } from "${CORE_PATH}";
export const svc = defineService<{ tr(s: string): string }>("pm-translate");
export const tick = defineEvent<{ v: number }>("pm-tick");
export default {
  name: "translate",
  apply: (c) => {
    c.provide(svc, { tr: (s) => \`<tr>\${s}\` });
    c.on(tick, () => {});
  },
};
`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    // 落位 root + token 注册表（裁决 9/10）：平台按名取 token 消费插件服务
    const token = svc.token("pm-translate") as ReturnType<typeof defineService<{ tr(s: string): string }>>;
    expect(ctx.use(token).tr("hi")).toBe("<tr>hi");
    expect(svc.serviceToken("pm-translate")).toBe(token);
    expect((await svc.list()).map((r) => r.name)).toEqual(["translate"]);
    expect((await svc.list()).map((r) => r.name)).toEqual(["translate"]);
  });

  it("apply 抛错：只炸插件 scope，平台存活，错误可查", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "broken",
      `export default { name: "broken", apply: () => { throw new Error("apply exploded"); } };`,
    );
    const result = await svc.install({ path: file });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("apply exploded");
    alive(ctx)();
    const errors = await svc.errors("broken");
    expect(errors[0]).toMatchObject({ plugin: "broken", phase: "install", message: expect.stringContaining("apply exploded") });
  });

  it("emit 监听器错误：归属记录 + 不外抛 + 信封；waterfall 错误：记录 + dispatch reject", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "fragile",
      `import { defineEvent, defineWaterfall } from "${CORE_PATH}";
export const tick = defineEvent<{ v: number }>("pm-fragile-tick");
export const wf = defineWaterfall<number, number>("pm-fragile-wf");
export default {
  name: "fragile",
  apply: (c) => {
    c.on(tick, () => { throw new Error("emit boom"); });
    c.on(wf, async (i, next) => { throw new Error("wf boom"); });
  },
};
`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    const envelopes: string[] = [];
    ctx.on(pluginEvent, ({ plugin, kind }) => envelopes.push(`${plugin}/${kind}`));
    const tick = svc.token("pm-fragile-tick") as ReturnType<typeof defineEvent<{ v: number }>>;
    const wf = svc.token("pm-fragile-wf") as ReturnType<typeof defineWaterfall<number, number>>;
    expect(() => ctx.emit(tick, { v: 1 })).not.toThrow();
    await expect(ctx.dispatch(wf, 1, async (i) => i)).rejects.toThrow("wf boom");
    const errors = await svc.errors("fragile");
    expect(errors.map((e) => e.where)).toContain("pm-fragile-tick@emit");
    expect(errors.map((e) => e.where)).toContain("pm-fragile-wf@waterfall");
    expect(envelopes).toContain("fragile/listener-error");
  });

  it("重名拒 + replace 重装（contracts 稳定模块承载共享 token 身份）", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    // 共享 token 住在稳定 contracts 模块（裁决 10：模块身份是 token 身份的载体，
    // 热换的是实现文件，contracts 不 bust——宿主与 v1/v2 拿到同一批 token 对象）
    await writeFile(
      join(root, "contracts.ts"),
      `import { defineEvent, defineService } from "${CORE_PATH}";
export const tick = defineEvent<{ v: number }>("pm-swap-tick");
export const state = defineService<{ n: number }>("pm-swap-state");
`,
      "utf8",
    );
    const contracts = (await import(join(root, "contracts.ts"))) as {
      tick: ReturnType<typeof defineEvent<{ v: number }>>;
      state: ReturnType<typeof defineService<{ n: number }>>;
    };
    ctx.provide(contracts.state, { n: 0 });

    const file = await writePlugin(
      root,
      "counter",
      `import { tick, state } from "./contracts.ts";
export default { name: "counter", apply: (c) => { c.on(tick, () => { c.use(state).n += 1; }); } };`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("replace") });

    const fileV2 = join(root, "counter-v2.ts");
    await writeFile(
      fileV2,
      `import { tick, state } from "./contracts.ts";
export default { name: "counter", apply: (c) => { c.on(tick, () => { c.use(state).n += 10; }); } };`,
      "utf8",
    );
    await expect(svc.install({ path: fileV2, replace: true })).resolves.toMatchObject({ ok: true });
    ctx.emit(contracts.tick, { v: 1 });
    expect(ctx.use(contracts.state).n).toBe(10); // 新行为生效，旧监听器已随卸载消失，状态保真
  });

  it("uninstall 依赖检查：非空拒（列出依赖方）、force 放行", async () => {
    const { svc, root } = await setup({ approve: () => true });
    const base = await writePlugin(
      root,
      "base",
      `import { defineService } from "${CORE_PATH}";
export default { name: "base", apply: (c) => { c.provide(defineService<{ n: number }>("pm-base-svc"), { n: 1 }); } };`,
    );
    const dep = await writePlugin(
      root,
      "dep",
      `import { defineService } from "${CORE_PATH}";
export default { name: "dep", inject: ["base"], apply: () => {} };`,
    );
    await expect(svc.install({ path: base })).resolves.toMatchObject({ ok: true });
    await expect(svc.install({ path: dep })).resolves.toMatchObject({ ok: true });
    expect(svc.dependentsOf("base")).toEqual(["dep"]);
    await expect(svc.uninstall("base")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("dependents: dep"),
    });
    await expect(svc.uninstall("base", { force: true })).resolves.toMatchObject({ ok: true });
    expect((await svc.list()).map((r) => r.name)).toEqual(["dep"]);
  });

  it("错误日志环形上限", async () => {
    const ctx = createContext();
    const root = await makeRoot();
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        errorLogLimit: 3,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const file = await writePlugin(
      root,
      "noisy",
      `import { defineEvent } from "${CORE_PATH}";
export const tick = defineEvent<{ v: number }>("pm-noisy");
export default {
  name: "noisy",
  apply: (c) => { c.on(tick, () => { throw new Error("noise"); }); },
};
`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    const tick = svc.token("pm-noisy") as ReturnType<typeof defineEvent<{ v: number }>>;
    for (let i = 0; i < 6; i += 1) ctx.emit(tick, { v: i });
    expect(svc.errors("noisy")).toHaveLength(3);
  });

  it("同名并发互斥：两个并发 install 不双登记", async () => {
    const { svc, root } = await setup({ approve: () => true });
    const file = await writePlugin(root, "race", `export default { name: "race", apply: async () => { await new Promise((r) => setTimeout(r, 5)); } };`);
    const [a, b] = await Promise.all([svc.install({ path: file }), svc.install({ path: file })]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1);
    expect((await svc.list()).filter((r) => r.name === "race")).toHaveLength(1);
  });

  it("guard 监听器错误按弃权（路由不改变语义）", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "guardy",
      `import { defineGuard } from "${CORE_PATH}";
export const g = defineGuard<{ v: number }>("pm-guard");
export default {
  name: "guardy",
  apply: (c) => {
    c.on(g, () => { throw new Error("guard boom"); });
    c.on(g, () => ({ kind: "deny" as const, reason: "legit" }));
  },
};
`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    const g = svc.token("pm-guard") as ReturnType<typeof defineGuard<{ v: number }>>;
    const verdict = await ctx.dispatch(g, { v: 1 });
    expect(verdict).toEqual({ kind: "deny", reason: "legit" }); // 坏守卫按弃权
    expect((await svc.errors("guardy")).map((e) => e.where)).toContain("pm-guard@guard");
  });
});

describe("process 模式：审计与信封", () => {
  it("生命周期进审计端口；装卸信封广播", async () => {
    const ctx = createContext();
    const root = await makeRoot();
    const auditLines: string[] = [];
    await loadPlugins(ctx, [
      createPluginManager({ ctx, roots: [root], approveInstall: () => true, audit: { append: async (e) => { auditLines.push(e.kind); } } }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const envelopes: string[] = [];
    ctx.on(pluginEvent, ({ kind }) => envelopes.push(kind));
    const file = await writePlugin(root, "aud", `export default { name: "aud", apply: () => {} };`);
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    await expect(svc.uninstall("aud")).resolves.toMatchObject({ ok: true });
    expect(auditLines).toEqual(["install", "uninstall"]);
    expect(envelopes).toEqual(["installed", "uninstalled"]);
  });

  it("vi spy 兜底：安装失败也进审计", async () => {
    const spy = vi.fn();
    const ctx = createContext();
    const root = await makeRoot();
    await loadPlugins(ctx, [createPluginManager({ ctx, roots: [root], audit: { append: async () => { spy(); } } })]);
    await expect(ctx.use(pluginManagerService).install({ path: "/nope" })).resolves.toMatchObject({ ok: false });
    expect(spy).toHaveBeenCalled();
  });
});

describe("process 模式：审查修复回归", () => {
  it("#6 卸载失败折算 err（不向调用方抛异常）且登记不卡死，可重装", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "badunload",
      `export default {
  name: "badunload",
  apply: () => () => { throw new Error("unload boom"); },
};
`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    const removed = await svc.uninstall("badunload"); // 不抛——折算 err
    expect(removed).toMatchObject({ ok: false });
    expect(removed.ok === false && removed.reason).toContain("unload boom");
    expect((await svc.list()).filter((r) => r.name === "badunload")).toHaveLength(0); // 登记已清
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true }); // 重装不卡死
    alive(ctx)();
  });

  it("#12 install-failed 信封发射", async () => {
    const { svc, root, ctx } = await setup({ approve: () => true });
    const envelopes: string[] = [];
    ctx.on(pluginEvent, ({ kind }) => envelopes.push(kind));
    const file = await writePlugin(root, "envfail", `export default { name: "envfail", apply: () => { throw new Error("x"); } };`);
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: false });
    expect(envelopes).toContain("install-failed");
  });
});

describe("process 模式：e2e 批次修复回归", () => {
  it("卸载后 tokenTable 注销：serviceToken 不再返回已死服务的 token（症状：token 只增不减的泄漏与双轨语义）", async () => {
    const { svc, root } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "tok",
      `import { defineService } from "${CORE_PATH}";
export default { name: "tok", apply: (c) => { c.provide(defineService<{ n(): number }>("pm-p-tok"), { n: () => 1 }); } };`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    expect(svc.serviceToken("pm-p-tok")).toBeDefined();
    await expect(svc.uninstall("tok")).resolves.toMatchObject({ ok: true });
    expect(svc.serviceToken("pm-p-tok")).toBeUndefined(); // 与 worker 桥 teardown 同语义
  });

  it("apply 失败同样不留 token 残留", async () => {
    const { svc, root } = await setup({ approve: () => true });
    const file = await writePlugin(
      root,
      "tokfail",
      `import { defineService } from "${CORE_PATH}";
export const tok = defineService<{ n(): number }>("pm-p-tokfail");
export default { name: "tokfail", apply: (c) => { c.provide(tok, { n: () => 1 }); throw new Error("late boom"); } };`,
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: false });
    expect(svc.serviceToken("pm-p-tokfail")).toBeUndefined();
  });
});
