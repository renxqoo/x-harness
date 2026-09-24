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

/** 失败路径的 runtime-error/install-failed 审计是 fire-and-forget 追加（plugin-manager
 *  既有语义），落盘时序不定——轮询到连续两次读数一致且足量再断言（迟到的多余条
 *  不可见） */
async function waitForAudit(agentDir: string, count: number): Promise<string[]> {
  let previous: string[] | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const kinds = await auditKinds(agentDir);
      if (kinds.length >= count && previous !== undefined && JSON.stringify(kinds) === JSON.stringify(previous)) return kinds;
      previous = [...kinds];
    } catch {
      // 文件未落——继续轮询
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`audit entries not landed (expected >= ${String(count)}); last=${JSON.stringify(previous ?? null)}`);
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
    // 服务可用性：经 token 取分析面（script adapter 申报 contextWindow 200k——
    // 三级中的 runtime 申报级；200k 兜底级由包级无参用例覆盖）
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
    expect((await waitForAudit(agentDir, 3)).sort()).toEqual(["install-failed", "runtime-error", "uninstall"]); // 失败留痕 + 错误路由 + failed 记录清除（落盘顺序不定——多重集）
  }, 20_000);
});

describe("降级硬承诺（契约 4：任何装载失败不打挂装配）", () => {
  test("loadModule reject（包缺失/顶层抛错形态）：装配不挂 + 插件缺席 + 无登记", async () => {
    const agentDir = await tempDir("hub-plg-rej-");
    const assembled = await assembleWorkerAgent(
      {
        sessionsRoot: join(agentDir, "sessions"),
        trusted: false,
        agentDir,
        dial: { provider: "script", model: "script-1" },
        env: SCRIPT_ENV,
      },
      { externalPlugins: { loadModule: async () => { throw new Error("reject boom"); } } },
    );
    const svc = assembled.world.ctx.tryUse(pluginManagerService);
    expect(svc).toBeDefined();
    expect(svc?.serviceToken("token-analytics")).toBeUndefined();
    expect(svc?.list()).toEqual([]); // 拒绝路不进登记簿
    await assembled.handle.dispose();
    await teardownWorld(assembled.world);
  }, 20_000);

  test("uninstall 失败不短路收殓：坏 disposer 抛错 → stderr 告警 + world 仍收殓 + 审计完整", async () => {
    const agentDir = await tempDir("hub-plg-uld-");
    const assembled = await assembleWorkerAgent(
      {
        sessionsRoot: join(agentDir, "sessions"),
        trusted: false,
        agentDir,
        dial: { provider: "script", model: "script-1" },
        env: SCRIPT_ENV,
      },
      // 装载成功但 apply 返回的 disposer 卸载时抛错 → uninstall Result 失败
      { externalPlugins: { loadModule: async () => ({ default: { name: "token-analytics", apply: () => () => { throw new Error("unload boom"); } } }) } },
    );
    expect(assembled.world.ctx.tryUse(pluginManagerService)?.list().map((record) => record.status)).toEqual(["active"]);
    await assembled.handle.dispose();
    await expect(teardownWorld(assembled.world)).resolves.toBeUndefined(); // 失败仅告警，收殓必完成
    const kinds = await waitForAudit(agentDir, 2);
    expect(kinds).toContain("install");
    expect(kinds).toContain("uninstall");
  }, 20_000);
});
