// capabilities 能力面全量：facade 六方法、元能力排除、tokenTable 收敛、
// collision 拒、双参 apply（process 真 caps / worker 桥 caps）、P1 引擎层 vendor 拒。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineEvent, defineService, loadPlugins } from "@x-harness/core";
import type { AnyToken } from "@x-harness/core";
import { CapabilityNameError } from "../capabilities.ts";
import { createCapabilities } from "../capabilities.ts";
import { META_TOKEN_NAMES } from "../capabilities.ts";
import { inspectThirdParty, scanSourceForSdkImports, validateThirdPartyManifest } from "../validate-module.ts";
import { createPluginManager } from "../plugin-manager.ts";
import { pluginManagerService } from "../types.ts";

const CORE_PATH = new URL("../../../core/context/src/index.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ── facade 单元（createCapabilities 直测）────────────────────────────────────

describe("capabilities facade：六方法 + 元能力排除", () => {
  const setup = () => {
    const platform = createContext();
    const world = defineService<{ ping(): string }>("caps-world");
    const tick = defineEvent<{ v: number }>("caps-tick");
    const table = new Map<string, AnyToken>([
      [world.name, world],
      [tick.name, tick],
    ]);
    const calls: string[] = [];
    platform.provide(world, { ping: () => "pong" });
    const caps = createCapabilities({
      resolveToken: (name) => table.get(name),
      useToken: (t) => platform.use(t as never),
      tryUseToken: (t) => platform.tryUse(t as never),
      waitForToken: (t) => platform.waitFor(t as never),
      provideToken: (t, impl) => {
      table.set(t.name, t);
      return platform.provide(t as never, impl as never);
    },
      onToken: (t, listener) => platform.on(t as never, listener as never),
      emitToken: (t, payload) => platform.emit(t as never, payload as never),
    });
    return { caps, platform, table, calls, world, tick };
  };

  it("use/tryUse 按名取服务；缺席 use 抛、tryUse undefined", () => {
    const { caps } = setup();
    expect(caps.use<{ ping(): string }>("caps-world").ping()).toBe("pong");
    expect(caps.tryUse("caps-world")).toBeDefined();
    expect(() => caps.use("no-such")).toThrow('capability not available: "no-such"');
    expect(caps.tryUse("no-such")).toBeUndefined();
  });

  it("元能力名：use 抛 / tryUse undefined / waitFor 拒 / provide 抛 / on 抛 / emit 抛", async () => {
    const { caps } = setup();
    const noop = (): void => {};
    const sink = (): unknown => undefined;
    for (const name of META_TOKEN_NAMES) {
      expect(() => caps.use(name)).toThrow(CapabilityNameError);
      expect(caps.tryUse(name)).toBeUndefined();
      await expect(caps.waitFor(name)).rejects.toThrow(CapabilityNameError);
      expect(() => caps.provide(name, {})).toThrow(CapabilityNameError);
      expect(() => caps.on(name, noop)).toThrow(CapabilityNameError);
      expect(() => caps.emit(name, sink())).toThrow(CapabilityNameError);
    }
    expect(META_TOKEN_NAMES.has("plugin-manager")).toBe(true);
    expect(META_TOKEN_NAMES.has("plugin/loaded")).toBe(true);
  });

  it("provide/on/emit 按名注册与投递（同一 tokenTable 名字空间）", () => {
    const { caps } = setup();
    const heard: number[] = [];
    caps.provide("caps-mine", { hello: () => "hi" });
    caps.on("caps-tick", (payload) => heard.push((payload as { v: number }).v));
    caps.emit("caps-tick", { v: 7 });
    expect(heard).toEqual([7]);
    expect(caps.use<{ hello(): string }>("caps-mine").hello()).toBe("hi");
    // 卸载隔离：platform.dispose 后注册全回卷（不断言具体 dispose 时序——只断无泄漏异常）
    expect(() => caps.emit("caps-tick", { v: 8 })).not.toThrow();
  });

  it("waitFor 停靠：表内名 resolve 到实现；表外名拒（缺席语义）", async () => {
    const { caps, platform, table } = setup();
    const later = defineService<{ late(): string }>("caps-later");
    platform.provide(later, { late: () => "arrived" });
    table.set("caps-later", later); // 模拟装载层 onToken 登记
    await expect(caps.waitFor<{ late(): string }>("caps-later")).resolves.toEqual({ late: expect.any(Function) });
    await expect(caps.waitFor("caps-never")).rejects.toThrow(CapabilityNameError);
  });
});

// ── process 模式：双参 apply 装载闭环 ────────────────────────────────────────

describe("process 模式：apply(ctx, caps) 双参注入", () => {
  it("第三方件零 @x-harness import，经 caps 钩世界并 provide 服务", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pm-caps-"));
    tempDirs.push(root);
    const table = new Map<string, AnyToken>();
    const worldSvc = defineService<{ who(): string }>("caps-p-world");
    ctx.provide(worldSvc, { who: () => "platform" });
    table.set(worldSvc.name, worldSvc);

    const file = join(root, "third.ts");
    await writeFile(
      file,
      `export default {
  name: "third-demo",
  apply(ctx, caps) {
    const world = caps.use("caps-p-world");
    caps.provide("third-demo-svc", { label: world.who() });
  },
};\n`,
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        tokens: [worldSvc],
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const installed = await svc.install({ path: file, mode: "process" });
    expect(installed.ok).toBe(true);
    const token = svc.serviceToken("third-demo-svc");
    expect(token).toBeDefined();
    expect((ctx.use(token!) as { label: string }).label).toBe("platform");
  });

  it("caps.provide 的名字进 tokenTable（serviceToken 可查）——onToken 收集闭环", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pm-caps2-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "prov.ts"),
      `export default { name: "prov-demo", apply(_ctx, caps) { caps.provide("prov-svc", { v: 1 }); } };\n`,
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    await svc.install({ path: join(root, "prov.ts") });
    expect(svc.serviceToken("prov-svc")).toBeDefined();
    // 卸载后 tokenTable 清理（install.ts cleanupTokens 闭环）
    const out = await svc.uninstall("prov-demo");
    expect(out.ok).toBe(true);
    expect(svc.serviceToken("prov-svc")).toBeUndefined();
  });

  it("老插件单参 apply 不破坏（零回归锚）", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pm-caps3-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "legacy.ts"),
      `import { defineService } from "${CORE_PATH}";
export const legacySvc = defineService("legacy-svc");
export default { name: "legacy", apply(ctx) { ctx.provide(legacySvc, { ok: 1 }); } };\n`,
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const out = await svc.install({ path: join(root, "legacy.ts") });
    expect(out.ok).toBe(true);
    expect(svc.serviceToken("legacy-svc")).toBeDefined();
  });
});

// ── P1：引擎层 vendor 根拒 process 装载 ─────────────────────────────────────

describe("P1 引擎层：vendor 根路径恒 worker（第二层防御）", () => {
  it("vendor 根内 + mode:process → 装载拒（即使编排层被绕过）", async () => {
    const ctx = createContext({ onListenerError: () => {} });
    const vendorRoot = await mkdtemp(join(tmpdir(), "pm-vendor-"));
    tempDirs.push(vendorRoot);
    const otherRoot = await mkdtemp(join(tmpdir(), "pm-other-"));
    tempDirs.push(otherRoot);
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [vendorRoot, otherRoot],
        vendorRoots: [vendorRoot],
        approveInstall: () => true,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const rejected = await svc.install({
      path: join(vendorRoot, "evil.ts"),
      mode: "process",
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("requires worker mode");
    // 非 vendor 根照常 process（内置件不受影响）
    const file = join(otherRoot, "fine.ts");
    await writeFile(file, `export default { name: "fine", apply() {} };\n`);
    const fine = await svc.install({ path: file, mode: "process" });
    expect(fine.ok).toBe(true);
  });
});

// ── 第三方静态检查 ──────────────────────────────────────────────────────────

describe("第三方 inspect：manifest + SDK import 静态扫描", () => {
  const manifest = { name: "demo", apiVersion: 1, kind: "third-party" };

  it("manifest 合法形状过；缺字段/坏类型拒", () => {
    expect(validateThirdPartyManifest(manifest).ok).toBe(true);
    expect(validateThirdPartyManifest({ ...manifest, kind: "builtin" }).ok).toBe(false);
    expect(validateThirdPartyManifest({ ...manifest, name: "" }).ok).toBe(false);
    expect(validateThirdPartyManifest({ ...manifest, apiVersion: "1" }).ok).toBe(false);
    expect(validateThirdPartyManifest(null).ok).toBe(false);
    expect(validateThirdPartyManifest({ name: "x", kind: "third-party", apiVersion: 1, description: 3 }).ok).toBe(false);
  });

  it("裸 import / 动态 import / re-export 全抓；内核件写法不误伤（scan 面只查 @x-harness/*）", () => {
    expect(scanSourceForSdkImports('import { x } from "@x-harness/core";')).toEqual(["@x-harness/core"]);
    expect(scanSourceForSdkImports('export * from "@x-harness/session";')).toEqual(["@x-harness/session"]);
    expect(scanSourceForSdkImports('const m = await import("@x-harness/core");')).toEqual(["@x-harness/core"]);
    expect(scanSourceForSdkImports('import { x } from "node:path";')).toEqual([]);
    expect(scanSourceForSdkImports('import { x } from "some-lib";')).toEqual([]);
    // 非 SDK 说明符含 harnes 字样不误伤
    expect(scanSourceForSdkImports('import x from "my-harness-thing";')).toEqual([]);
  });

  it("inspectThirdParty 合成：manifest 拒优先；任一源文件带 SDK import 拒", () => {
    expect(inspectThirdParty({ manifest, sources: [] }).ok).toBe(true);
    expect(
      inspectThirdParty({ manifest: { name: "x" }, sources: [] }).ok,
    ).toBe(false);
    expect(
      inspectThirdParty({
        manifest,
        sources: [{ path: "a.ts", source: 'import b from "@x-harness/core";' }],
      }).reason,
    ).toContain("a.ts");
  });
});

// ── worker 模式：caps 经桥（RPC 按名过线）───────────────────────────────────

describe("worker 模式：apply(ctx, caps) 经桥", () => {
  it("第三方件 worker 装载，caps.use 平台服务（RPC）+ caps.provide 服务（main 可用）", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pm-wcaps-"));
    tempDirs.push(root);
    const remote = defineService<{ echo(v: string): string }>("caps-remote");
    ctx.provide(remote, { echo: (v) => `echo:${v}` });
    await writeFile(
      join(root, "wthird.ts"),
      `export default {
  name: "w-third",
  apply(_ctx, caps) {
    // RPC 代理：方法调用返回 Promise——apply 内同步取值不可行（跨线程事实），
    // 提供的方法经 main 侧 serviceProxy 转发（调用时才过线）
    const remote = caps.use("caps-remote");
    caps.provide("w-third-svc", { echo: (v) => remote.echo(v) });
  },
};\n`,
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        mode: "worker",
        tokens: [remote],
        applyTimeoutMs: 10_000,
        runtimeTimeoutMs: 5_000,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const out = await svc.install({ path: join(root, "wthird.ts"), mode: "worker" });
    expect(out.ok).toBe(true);
    const token = svc.serviceToken("w-third-svc");
    expect(token).toBeDefined();
    const impl = ctx.use(token!) as { echo(v: string): Promise<string> };
    // 双跳 RPC：main → worker（call）→ worker caps.use 代理 → main（svc-call）→ 回程
    await expect(impl.echo("hi")).resolves.toBe("echo:hi");
  });
});

// ── 对抗审查 2a 回归：ctx.on 旁路封口（worker 与 process 两侧）───────────────

describe("META token 旁路封口（ctx.on 直听元能力名 = 拒）", () => {
  it("worker 模式：插件经 ctx.on 监听 plugin/loaded → 装载拒（apply 失败留痕）", async () => {
    const ctx = createContext();
    const root = await mkdtemp(join(tmpdir(), "pm-meta-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "meta-listener.ts"),
      [
        "export default {",
        '  name: "meta-listener",',
        "  apply(ctx) {",
        `    ctx.on({ kind: "event", mode: "emit", name: "plugin/loaded", freeze: "none" }, () => {});`,
        "  },",
        "};",
      ].join("\n"),
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        mode: "worker",
        applyTimeoutMs: 10_000,
        runtimeTimeoutMs: 5_000,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const out = await svc.install({ path: join(root, "meta-listener.ts"), mode: "worker" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("meta token");
  }, 15_000);

  it("process 模式：wrapper on 同判定（plugin/event 拒）", async () => {
    const ctx = createContext({ onListenerError: () => {} });
    const root = await mkdtemp(join(tmpdir(), "pm-meta2-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "meta2.ts"),
      [
        "export default {",
        '  name: "meta2",',
        "  apply(ctx) {",
        `    ctx.on({ kind: "event", mode: "emit", name: "plugin/event", freeze: "shell" }, () => {});`,
        "  },",
        "};",
      ].join("\n"),
    );
    await loadPlugins(ctx, [
      createPluginManager({
        ctx,
        roots: [root],
        approveInstall: () => true,
        audit: { append: async () => {} },
      }),
    ]);
    const svc = ctx.use(pluginManagerService);
    const out = await svc.install({ path: join(root, "meta2.ts"), mode: "process" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("meta token");
  });
});
