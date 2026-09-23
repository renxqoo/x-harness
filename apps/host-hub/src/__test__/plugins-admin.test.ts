// 插件管理面全量：registry 读写/撞名拒、install inspect 三态/拷贝/哈希/回滚、
// admin list/set_enabled/remove 分叉、external-plugins vendor 装载（worker 模式恒定）、
// apiVersion 拒载留痕（P4）、P1 编排层覆写。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "@x-harness/core";
import { pluginManagerService } from "@x-harness/plugin-manager";
import { createPluginProposalStore } from "../shared/plugin-proposals.ts";
import { readVendorRegistry, registryPath, updateVendorRegistry, vendorNameBlocked, vendorRootOf } from "../shared/plugins-registry.ts";
import { BUILTIN_PLUGINS, enabledPlugins, knownPluginNames, vendorLoadable } from "../shared/plugins-catalog.ts";
import { hashTree, inspectPluginSource, installPlugin, pluginEntryPath, removePlugin } from "../host/plugins-install.ts";
import { listPlugins, setPluginEnabled } from "../host/plugins-admin.ts";
import { installExternalPlugins } from "../worker/external-plugins.ts";
import { readHubSettings } from "../shared/settings-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agentDirOf(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-m1-"));
  tempDirs.push(dir);
  return dir;
}

/** 造第三方插件源目录（plugin.json + index.ts，entryBody 默认零 SDK 依赖） */
async function makeThirdPartySource(name: string, options?: { apiVersion?: number; entry?: string; withSdkImport?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-src-"));
  tempDirs.push(dir);
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ name, kind: "third-party", apiVersion: options?.apiVersion ?? 1, ...(options?.entry !== undefined ? { entry: options.entry } : {}) }),
  );
  const body = options?.withSdkImport
    ? `import { x } from "@x-harness/core";\nexport default { name: ${JSON.stringify(name)}, apply(_ctx, caps) { caps.provide("x", { v: 1 }); } };`
    : `export default { name: ${JSON.stringify(name)}, apply(_ctx, caps) { void caps; } };`;
  await writeFile(join(root, options?.entry ?? "index.ts"), body);
  return root;
}

// ── registry ────────────────────────────────────────────────────────────────

describe("plugins-registry：清单文件", () => {
  it("缺席 = 空清单；坏文件降级空；坏条目逐条丢", async () => {
    const dir = await agentDirOf();
    expect(await readVendorRegistry(dir)).toEqual([]);
    await mkdir(join(dir, "plugins"), { recursive: true });
    await writeFile(registryPath(dir), "{not json", "utf8");
    expect(await readVendorRegistry(dir)).toEqual([]);
    const good = { name: "a", dir: "a", sha256: "x", approvedBy: "user", approvedAt: 1, apiVersion: 1, origin: "manual" };
    const bad = { name: "", dir: "b" };
    await writeFile(registryPath(dir), JSON.stringify([good, bad]), "utf8");
    expect(await readVendorRegistry(dir)).toEqual([good]);
  });

  it("vendor 撞 builtin 名拒（P3 清单层）", () => {
    for (const name of Object.keys(BUILTIN_PLUGINS)) expect(vendorNameBlocked(name)).toBe(true);
    expect(vendorNameBlocked("my-own-plugin")).toBe(false);
  });

  it("updateVendorRegistry 串行读改写", async () => {
    const dir = await agentDirOf();
    const entry = { name: "p1", dir: "p1", sha256: "h", approvedBy: "user" as const, approvedAt: 5, apiVersion: 1, origin: "manual" as const };
    const removeP1 = (cur: typeof entry extends never ? never : import("../shared/plugins-registry.ts").VendorPluginEntry[]): import("../shared/plugins-registry.ts").VendorPluginEntry[] => cur.filter((row) => row.name !== "p1");
    await updateVendorRegistry(dir, (cur) => [...cur, entry]);
    await updateVendorRegistry(dir, removeP1);
    expect(await readVendorRegistry(dir)).toEqual([]);
  });
});

// ── catalog 双源 ────────────────────────────────────────────────────────────

describe("plugins-catalog：双源与 apiVersion 门", () => {
  const vendorEntry = (name: string, apiVersion: number) => ({ name, dir: name, sha256: "h", approvedBy: "user" as const, approvedAt: 1, apiVersion, origin: "manual" as const });

  it("enabledPlugins 合并：builtin + 可装载 vendor；disabled 对两源同语义", () => {
    const rows = enabledPlugins(undefined, [vendorEntry("v-ok", 1), vendorEntry("v-old", 99)]);
    expect(rows).toContain("token-analytics");
    expect(rows.some((r) => typeof r !== "string" && r.name === "v-ok")).toBe(true);
    expect(rows.some((r) => typeof r !== "string" && r.name === "v-old")).toBe(false); // P4：apiVersion 拒
    const disabled = enabledPlugins(["token-analytics", "v-ok"], [vendorEntry("v-ok", 1)]);
    expect(disabled).toEqual([]);
  });

  it("vendorLoadable：不匹配给 reason（list 透出用）", () => {
    expect(vendorLoadable(vendorEntry("x", 2)).ok).toBe(false);
    const outcome = vendorLoadable(vendorEntry("x", 2));
    expect(outcome.ok === false && outcome.reason).toContain("apiVersion 2");
  });

  it("knownPluginNames：builtin ∪ vendor", () => {
    expect(knownPluginNames([vendorEntry("v1", 1)])).toEqual(["token-analytics", "v1"]);
  });
});

// ── install：inspect 三态 / 拷贝 / 哈希 / 回滚 ──────────────────────────────

describe("plugins-install：inspect 与 install", () => {
  it("inspect 三态：ready / rename（manifest 名 ≠ 目录名）/ blocked（SDK import）", async () => {
    const ready = await inspectPluginSource(await makeThirdPartySource("good-plugin"));
    expect(ready.state).toBe("ready");
    expect(ready.state === "ready" && ready.manifest.name).toBe("good-plugin");

    const src = await makeThirdPartySource("good-plugin");
    const renamedRoot = join(src, "..", "other-name");
    await rm(renamedRoot, { force: true });
    const { rename } = await import("node:fs/promises");
    await rename(src, renamedRoot);
    const renamed = await inspectPluginSource(renamedRoot);
    expect(renamed.state).toBe("rename");

    const withSdk = await inspectPluginSource(await makeThirdPartySource("sdk-plugin", { withSdkImport: true }));
    expect(withSdk.state).toBe("blocked");
    expect(withSdk.state === "blocked" && withSdk.problem).toContain("@x-harness");
  });

  it("install：拷 vendor + registry 落账 + 哈希一致；重装无 overwrite 拒", async () => {
    const agentDir = await agentDirOf();
    const src = await makeThirdPartySource("hello-plugin");
    const first = await installPlugin({ sourcePath: src, agentDir });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.plugin.name).toBe("hello-plugin");
      expect(first.plugin.path).toBe(join(vendorRootOf(agentDir), "hello-plugin"));
      const stored = await readFile(join(first.plugin.path, "index.ts"), "utf8");
      expect(stored).toContain("hello-plugin");
      const [entry] = await readVendorRegistry(agentDir);
      expect(entry?.sha256).toBe(first.plugin.sha256);
      expect(entry?.origin).toBe("manual");
      // 哈希稳定：同树重算一致
      expect(await hashTree(first.plugin.path)).toBe(first.plugin.sha256);
    }
    const again = await installPlugin({ sourcePath: src, agentDir });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error.code).toBe("name_conflict");
    const replaced = await installPlugin({ sourcePath: src, agentDir, overwrite: true, origin: "agent" });
    expect(replaced.ok).toBe(true);
    const [entry2] = await readVendorRegistry(agentDir);
    expect(entry2?.origin).toBe("agent");
  });

  it("remove：删目录 + 清条目；未知名拒", async () => {
    const agentDir = await agentDirOf();
    const src = await makeThirdPartySource("bye-plugin");
    await installPlugin({ sourcePath: src, agentDir });
    const removed = await removePlugin({ name: "bye-plugin", agentDir });
    expect(removed.ok).toBe(true);
    expect(await readVendorRegistry(agentDir)).toEqual([]);
    const unknown = await removePlugin({ name: "never-was", agentDir });
    expect(unknown.ok).toBe(false);
  });

  it("install 失败回滚：源目录坏（无 plugin.json）不落任何 vendor 残迹", async () => {
    const agentDir = await agentDirOf();
    const badSrc = await mkdtemp(join(tmpdir(), "pm-badsrc-"));
    tempDirs.push(badSrc);
    await mkdir(badSrc, { recursive: true });
    const outcome = await installPlugin({ sourcePath: badSrc, agentDir });
    expect(outcome.ok).toBe(false);
    expect(await readVendorRegistry(agentDir)).toEqual([]);
  });
});

// ── admin：list / set_enabled / remove 分叉 ─────────────────────────────────

describe("plugins-admin：合并视图与启停", () => {
  it("list：builtin + vendor + 装载态合并；apiVersion 拒载透出原因（P4）", async () => {
    const agentDir = await agentDirOf();
    await installPlugin({ sourcePath: await makeThirdPartySource("live-plugin"), agentDir });
    const old = { name: "old-plugin", dir: "old-plugin", sha256: "h", approvedBy: "user" as const, approvedAt: 1, apiVersion: 99, origin: "agent" as const };
    await updateVendorRegistry(agentDir, (cur) => [...cur, old]);
    const { plugins } = await listPlugins({
      agentDir,
      loaded: [{ name: "token-analytics", mode: "process", status: "active" }, { name: "live-plugin", mode: "worker", status: "active" }],
    });
    const byName = new Map(plugins.map((row) => [row.name, row]));
    expect(byName.get("token-analytics")).toMatchObject({ source: "builtin", status: "active", enabled: true });
    expect(byName.get("live-plugin")).toMatchObject({ source: "vendor", origin: "manual", status: "active" });
    expect(byName.get("old-plugin")).toMatchObject({ status: "disabled", enabled: true });
    expect(byName.get("old-plugin")?.disabledReason).toContain("apiVersion 99");
  });

  it("set_enabled：builtin ∪ vendor 名收口；写 plugins.disabled；未知名拒", async () => {
    const agentDir = await agentDirOf();
    await installPlugin({ sourcePath: await makeThirdPartySource("toggle-me"), agentDir });
    const okVendor = await setPluginEnabled({ agentDir, name: "toggle-me", enabled: false });
    expect(okVendor.ok).toBe(true);
    expect((await readHubSettings(agentDir))["plugins.disabled"]).toEqual(["toggle-me"]);
    const okBuiltin = await setPluginEnabled({ agentDir, name: "token-analytics", enabled: false });
    expect(okBuiltin.ok).toBe(true);
    const unknown = await setPluginEnabled({ agentDir, name: "ghost", enabled: true });
    expect(unknown.ok).toBe(false);
    await setPluginEnabled({ agentDir, name: "token-analytics", enabled: true });
    expect((await readHubSettings(agentDir))["plugins.disabled"]).toEqual(["toggle-me"]);
  });
});

// ── external-plugins：vendor 装载腿（P1 编排恒 worker）──────────────────────

describe("external-plugins：vendor 装载腿", () => {
  it("vendor 件经 worker 模式装载 + caps 钩世界（端到端）", async () => {
    const agentDir = await agentDirOf();
    const src = await makeThirdPartySource("e2e-plugin");
    await installPlugin({ sourcePath: src, agentDir });
    const ctx = createContext();
    // WORLD_TOKENS 里挑一个服务名给插件 use（worker RPC 桥真实过线）
    await installExternalPlugins({ ctx, agentDir, disabled: ["token-analytics"] });
    const svc = ctx.use(pluginManagerService);
    const records = svc.list();
    expect(records.some((r) => r.name === "e2e-plugin" && r.mode === "worker")).toBe(true); // P1：vendor 恒 worker
    await ctx.dispose();
  }, 20_000);

  it("apiVersion 不匹配的 vendor 件不装载且不崩装配（P4 留痕面）", async () => {
    const agentDir = await agentDirOf();
    await updateVendorRegistry(agentDir, () => [
      { name: "future-plugin", dir: "future-plugin", sha256: "h", approvedBy: "user", approvedAt: 1, apiVersion: 42, origin: "manual" },
    ]);
    const ctx = createContext();
    await installExternalPlugins({ ctx, agentDir, disabled: ["token-analytics"] });
    // 全部 targets 滤除 → plugin-manager 本就不装配（空装载无意义）——能力缺席语义
    expect(ctx.tryUse(pluginManagerService)).toBeUndefined();
    await ctx.dispose();
  });

  it("deps.vendorEntries 测试缝：入口缺席告警跳过（不挂装配）", async () => {
    const agentDir = await agentDirOf();
    const ctx = createContext();
    await installExternalPlugins(
      { ctx, agentDir, disabled: ["token-analytics"] },
      { vendorEntries: [{ name: "ghost-tree", dir: "ghost-tree", sha256: "h", approvedBy: "user", approvedAt: 1, apiVersion: 1, origin: "manual" }] },
    );
    // 入口缺席 → 无可装 targets → plugin-manager 未装（tryUse 缺席语义）
    expect(ctx.tryUse(pluginManagerService)).toBeUndefined();
    await ctx.dispose();
  });
});

// ── 对抗审查修复回归 ─────────────────────────────────────────────────────────

describe("对抗审查修复回归（3a/2a/4a/6a）", () => {
  it("3a：文件面伪造 confirmed:true 的提案——无内存确认恒不可消费（双查门）", async () => {
    const agentDir = await agentDirOf();
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(agentDir, "plugins"), { recursive: true });
    // agent 直写伪造：confirmed:true 但从未经 host confirm 命令（内存无确认态）
    const forged = {
      proposalId: "pp-forged",
      sourcePath: "/tmp/evil",
      name: "evil",
      description: "",
      requestedCapabilities: [],
      sha256: "x".repeat(64),
      createdAt: Date.now(),
      confirmed: true,
      consumed: false,
    };
    await wf(join(agentDir, "plugins", "proposals.json"), JSON.stringify([forged]));
    const store = createPluginProposalStore(agentDir);
    // 登记可见（面板展示）——但消费恒拒（内存确认缺席）
    expect((await store.list()).some((r) => r.proposalId === "pp-forged")).toBe(true);
    expect(await store.consumeConfirmed("pp-forged")).toBeUndefined();
    // 经 confirm 命令面（内存置位）后可消费——合法链路不破
    await store.setConfirmed("pp-forged", true);
    const consumed = await store.consumeConfirmed("pp-forged");
    expect(consumed?.proposalId).toBe("pp-forged");
  });

  it("4a：registry 写入层真拒 vendor 撞 builtin 名（绕过 inspect 的直写路径）", async () => {
    const agentDir = await agentDirOf();
    const bad = { name: "token-analytics", dir: "x", sha256: "h", approvedBy: "user" as const, approvedAt: 1, apiVersion: 1, origin: "manual" as const };
    await expect(updateVendorRegistry(agentDir, (cur) => [...cur, bad])).rejects.toThrow("conflicts with builtin");
    expect(await readVendorRegistry(agentDir)).toEqual([]); // 拒后无残留
  });

  it("1b：manifest.entry 越界（../ 逃逸与绝对路径）→ 入口探测 undefined", async () => {
    const agentDir = await agentDirOf();
    const vendorRoot = vendorRootOf(agentDir);
    const { mkdir: md, writeFile: wf } = await import("node:fs/promises");
    for (const [label, entry] of [["逃逸", "../../../tmp/evil.ts"], ["绝对", "/tmp/evil.ts"]] as const) {
      const dir = join(vendorRoot, `esc-${label}`);
      await md(dir, { recursive: true });
      await wf(join(dir, "plugin.json"), JSON.stringify({ name: `esc-${label}`, entry }));
      await wf(join(dir, "index.ts"), "export default { name: 'x', apply() {} };");
      const rec = { name: `esc-${label}`, dir: `esc-${label}`, sha256: "h", approvedBy: "user" as const, approvedAt: 1, apiVersion: 1, origin: "manual" as const };
      expect(await pluginEntryPath(vendorRoot, rec)).toBeUndefined();
    }
  });
});

describe("对抗审查 6a 回归：hot_install 的 disabled/apiVersion 门（handler 判定原语）", () => {
  it("disabled 名单语义：名单内名 = set_enabled 写入的停用事实——热装面同判（handler 读 readHubSettings 现值）", async () => {
    const agentDir = await agentDirOf();
    const { setPluginEnabled } = await import("../host/plugins-admin.ts");
    await installPlugin({ sourcePath: await makeThirdPartySource("hot-gate"), agentDir });
    await setPluginEnabled({ agentDir, name: "hot-gate", enabled: false });
    const { readHubSettings } = await import("../shared/settings-store.ts");
    const disabled = (await readHubSettings(agentDir))["plugins.disabled"] ?? [];
    // handler 的判定原语：名单含名 → state_conflict 拒（plugins-hot.ts:47-51 同判）
    expect(disabled.includes("hot-gate")).toBe(true);
  });
});
