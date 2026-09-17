// 覆盖补齐：wrapper 委托面 / 文件审计 / worker 崩溃收殓 / 服务冲突 fail-fast。
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineEvent, defineSerial, defineService, loadPlugins } from "@x-harness/core";
import { createPluginManager } from "../plugin-manager.ts";
import { pluginManagerService } from "../types.ts";
import type { PluginManagerService } from "../types.ts";

const CORE_PATH = new URL("../../../core/src/index.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setupWorker(options?: { tokens?: never[] }): Promise<{
  ctx: ReturnType<typeof createContext>;
  svc: PluginManagerService;
  root: string;
}> {
  const ctx = createContext();
  const root = await mkdtemp(join(tmpdir(), "pmc-"));
  tempDirs.push(root);
  await loadPlugins(ctx, [
    createPluginManager({
      ctx,
      roots: [root],
      approveInstall: () => true,
      mode: "worker",
      tokens: options?.tokens ?? [],
      applyTimeoutMs: 5_000,
      runtimeTimeoutMs: 5_000,
      audit: { append: async () => {} },
    }),
  ]);
  return { ctx, svc: ctx.use(pluginManagerService), root };
}

describe("process 模式：wrapper 委托面全走", () => {
  it("插件经 wrapper 使用 tryUse/waitFor/emit/dispatch/scope/effect/链", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pmw2-"));
    tempDirs.push(root);
    const trace: string[] = [];
    await loadPlugins(ctx, [
      createPluginManager({ ctx, roots: [root], approveInstall: () => true, audit: { append: async () => {} } }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const file = join(root, "kitchen.ts");
    await writeFile(
      file,
      `import { defineEvent, defineSerial, defineService } from "${CORE_PATH}";
export const room = defineEvent<{ v: number }>("pm-k-room");
export const agenda = defineSerial<{ step: string }>("pm-k-agenda");
export const host = defineService<{ name: string }>("pm-k-host");
export default {
  name: "kitchen",
  apply: async (c) => {
    if (c.tryUse(host) !== undefined) throw new Error("host should be absent");
    c.emit(room, { v: 1 }); // 委托 scope.emit → root 听得见（chain-up）
    const inner = c.scope({ agentId: "inner" });
    inner.effect(() => {});
    await inner.dispose();
    await c.dispatch(agenda, { step: "s1" }); // 委托 scope.dispatch
    const chain = c.createChain<number, number>(async (i) => i * 2);
    c.onChain(chain, async (i, next) => next(i + 1));
    void await chain.dispatch(1);
    await c.waitFor(host).then(() => {}); // 委托 waitFor：host 稍后到
  },
};
`,
      "utf8",
    );
    // 监听/host token 均取自插件模块（同实例 → 同 token 对象——裁决 10 的模块身份载体）
    const mod = (await import(file)) as {
      host: ReturnType<typeof defineService<{ name: string }>>;
      room: ReturnType<typeof defineEvent<{ v: number }>>;
      agenda: ReturnType<typeof defineSerial<{ step: string }>>;
    };
    ctx.on(mod.room, ({ v }) => trace.push(`room:${v}`));
    ctx.on(mod.agenda, ({ step }) => { trace.push(`agenda:${step}`); });
    setTimeout(() => { ctx.provide(mod.host, { name: "late" }); }, 30);
    const installed = await svc.install({ path: file });
    expect(installed).toMatchObject({ ok: true });
    expect(trace).toContain("room:1");
    expect(trace).toContain("agenda:s1");
  });
});

describe("文件审计（缺省 JSONL）", () => {
  it("install/uninstall 落 JSONL 文件", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pma-"));
    tempDirs.push(root);
    await loadPlugins(ctx, [createPluginManager({ ctx, roots: [root], approveInstall: () => true })]);
    const svc = ctx.use(pluginManagerService);
    const file = join(root, "a.ts");
    await writeFile(file, `export default { name: "a", apply: () => {} };`, "utf8");
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    await expect(svc.uninstall("a")).resolves.toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 100)); // 审计为 fire-and-forget，等 flush
    const lines = (await readFile(join(root, ".plugin-manager-audit.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["install", "uninstall"]);
  });
});

describe("worker 模式：收殓分支", () => {
  it("worker 崩溃（process.exit）→ exit 收殓 → 登记清除 + 错误留痕", async () => {
    const { svc, root, ctx } = await setupWorker();
    const file = join(root, "dies.ts");
    await writeFile(
      file,
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "dies",
  apply: (c) => {
    c.provide(defineService<{ boom(): void }>("pm-c-boom"), { boom: () => { process.exit(1); } });
  },
};
`,
      "utf8",
    );
    await expect(svc.install({ path: file })).resolves.toMatchObject({ ok: true });
    const token = svc.serviceToken("pm-c-boom");
    if (token === undefined) throw new Error("token missing");
    const proxy = ctx.use(token as ReturnType<typeof defineService<{ boom(): void }>>);
    await expect(proxy.boom()).rejects.toBeTruthy(); // worker 死了，RPC 断
    await new Promise((r) => setTimeout(r, 100)); // exit 收殓异步
    expect(svc.list().filter((r) => r.name === "dies")).toHaveLength(0);
    const errors = svc.errors("dies");
    expect(errors.some((e) => e.message.includes("killed") || e.message.includes("exit"))).toBe(true);
    expect(() => ctx.effect(() => {})).not.toThrow(); // 平台存活
  });

  it("provided 服务撞平台同名 → fail-fast 装载失败", async () => {
    const fresh = await setupWorker();
    const clash = join(fresh.root, "clash.ts");
    await writeFile(
      clash,
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "clash",
  apply: (c) => { c.provide(defineService<{ q(): string }>("pm-c-clash"), { q: () => "x" }); },
};
`,
      "utf8",
    );
    const result = await fresh.svc.install({ path: clash });
    expect(result).toMatchObject({ ok: true }); // 无冲突基线
    const clash2 = join(fresh.root, "clash2.ts");
    await writeFile(
      clash2,
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "clash2",
  apply: (c) => { c.provide(defineService<{ q(): string }>("pm-c-clash"), { q: () => "y" }); },
};
`,
      "utf8",
    );
    const second = await fresh.svc.install({ path: clash2 });
    expect(second).toMatchObject({ ok: false });
    expect(second.ok === false && second.reason).toContain("conflict");
  });
});
