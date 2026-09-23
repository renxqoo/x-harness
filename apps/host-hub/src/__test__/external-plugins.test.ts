// 外部插件装载契约（docs/PLUGINS.md 契约 3/4）：词表封闭性、缺省全装载、
// disabled/agentDir 缺席/解析失败/装载失败降级不打挂装配、teardown 审计
// install→uninstall 恰好各一次。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginManagerService } from "@x-harness/plugin-manager";
import { assembleWorkerAgent, teardownWorld } from "../worker/assembly.ts";
import { enabledBuiltinPlugins, builtinPluginNames, BUILTIN_PLUGINS } from "../shared/plugins-catalog.ts";
import { resolveModuleBySpecifier } from "../worker/external-plugins.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const SCRIPT_ENV = { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]) };

async function auditKinds(agentDir: string): Promise<string[]> {
  const raw = await readFile(join(agentDir, "plugins", "audit.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe("内置插件词表", () => {
  test("封闭性对拍：词表键 == 文档词表（docs/PLUGINS.md 契约 3）", () => {
    expect(builtinPluginNames()).toEqual(["token-analytics"]);
    expect(BUILTIN_PLUGINS["token-analytics"]?.module).toBe("@x-harness/token-analytics");
  });

  test("enabled 面：缺省全装载；disabled 剔除；未知名不误伤（防御）", () => {
    expect(enabledBuiltinPlugins(undefined)).toEqual(["token-analytics"]);
    expect(enabledBuiltinPlugins([])).toEqual(["token-analytics"]);
    expect(enabledBuiltinPlugins(["token-analytics"])).toEqual([]);
    expect(enabledBuiltinPlugins(["nonexistent"])).toEqual(["token-analytics"]);
  });

  test("解析：module 说明符 → 绝对路径（file URL 规范化——install path 单源）", () => {
    const path = resolveModuleBySpecifier("@x-harness/token-analytics");
    expect(path.endsWith("packages/token-analytics/src/index.ts")).toBe(true);
  });
});

describe("装配期装载", () => {
  test("缺省全装载：serviceToken 按名在场；teardown 审计 install→uninstall 各一次", async () => {
    const agentDir = await tempDir("hub-plg-");
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(agentDir, "sessions"),
      trusted: false,
      agentDir,
      dial: { provider: "script", model: "script-1" },
      env: SCRIPT_ENV,
    });
    const svc = assembled.world.ctx.tryUse(pluginManagerService);
    expect(svc).toBeDefined();
    const token = svc?.serviceToken("token-analytics");
    expect(token).toBeDefined();
    // 服务可用性：经 token 取分析面（script 世界无窗口申报 → 200k 兜底）
    const analytics = assembled.world.ctx.use(token!) as { breakdown: () => { contextWindow: number; utilization: number } };
    const breakdown = analytics.breakdown();
    expect(breakdown.contextWindow).toBe(200_000);
    expect(typeof breakdown.utilization).toBe("number");

    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
    expect(await auditKinds(agentDir)).toEqual(["install", "uninstall"]); // 生命周期审计恰好各一次
  }, 20_000);

  test("plugins.disabled 跳过：manager 与插件均不装载（审计文件缺席）", async () => {
    const agentDir = await tempDir("hub-plg-d-");
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(agentDir, "sessions"),
      trusted: false,
      agentDir,
      pluginsDisabled: ["token-analytics"],
      dial: { provider: "script", model: "script-1" },
      env: SCRIPT_ENV,
    });
    expect(assembled.world.ctx.tryUse(pluginManagerService)).toBeUndefined();
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
    await expect(auditKinds(agentDir)).rejects.toThrow(); // 无审计文件
  }, 20_000);

  test("agentDir 缺席跳过（直连装配场景——不兜底 cwd 防审计污染）", async () => {
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(await tempDir("hub-plg-na-"), "sessions"),
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: SCRIPT_ENV,
    });
    expect(assembled.world.ctx.tryUse(pluginManagerService)).toBeUndefined();
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
  }, 20_000);

  test("解析失败降级：装配不挂，插件缺席", async () => {
    const agentDir = await tempDir("hub-plg-r-");
    const assembled = await assembleWorkerAgent(
      {
        sessionsRoot: join(agentDir, "sessions"),
        trusted: false,
        agentDir,
        dial: { provider: "script", model: "script-1" },
        env: SCRIPT_ENV,
      },
      { externalPlugins: { resolve: () => { throw new Error("resolve boom"); } } },
    );
    expect(assembled.world.ctx.tryUse(pluginManagerService)).toBeUndefined();
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
  }, 20_000);

  test("装载失败降级：坏模块 → 失败留痕不打挂装配；failed 记录可清", async () => {
    const agentDir = await tempDir("hub-plg-f-");
    const assembled = await assembleWorkerAgent(
      {
        sessionsRoot: join(agentDir, "sessions"),
        trusted: false,
        agentDir,
        dial: { provider: "script", model: "script-1" },
        env: SCRIPT_ENV,
      },
      // 坏模块：形状过关但 apply 抛错 → installProcess 失败留痕（registerFailure）
      { externalPlugins: { loadModule: async () => ({ default: { name: "token-analytics", apply: () => { throw new Error("apply boom"); } } }) } },
    );
    const svc = assembled.world.ctx.tryUse(pluginManagerService);
    expect(svc).toBeDefined(); // manager 在场（装载编排不因单件失败缺席）
    expect(svc?.serviceToken("token-analytics")).toBeUndefined(); // 插件本体失败
    expect(svc?.list().map((record) => [record.name, record.status])).toEqual([["token-analytics", "failed"]]);
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
    expect(await auditKinds(agentDir)).toEqual(["install-failed", "runtime-error", "uninstall"]); // 失败留痕 + 错误路由 + failed 记录清除
  }, 20_000);
});
