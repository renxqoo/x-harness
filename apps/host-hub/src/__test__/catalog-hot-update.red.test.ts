import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostCommands } from "../host/host-commands.ts";
import { readCatalog } from "../shared/catalog.ts";
import type { HostCommands } from "../host/host-commands.ts";

const roots: string[] = [];
async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  commands: HostCommands;
  agentDir: string;
  snapshotEnv: () => Record<string, string> | undefined;
  broadcasts: string[];
  cleanup: () => Promise<void>;
}

async function makeHost(): Promise<Harness> {
  const agentDir = await tempRoot("hub-snap-");
  let snapshot: Record<string, string> | undefined;
  const broadcasts: string[] = [];
  const commands = createHostCommands(
    {
      table: {
        get: () => undefined,
        holderOf: () => undefined,
        liveCount: () => 0,
        list: () => [],
        remove: () => undefined,
        update: () => undefined,
      } as never,
      pool: { liveThreadIds: () => [], deliverRaw: () => Promise.resolve() } as never,
      direct: {} as never,
      agentDir,
      sessionsRoot: join(agentDir, "sessions"),
      limits: { maxThreads: 4, idleRetireMs: 60_000, workerStaleMs: 60_000, workerExitTimeoutMs: 5_000, rssRetireBytes: 1 << 30, bashTimeoutMs: 30_000 },
      setLimits: () => undefined,
      emitClient: () => undefined,
      startedAt: Date.now(),
      version: "test",
    },
    {
      broadcastToWorkers: (line) => broadcasts.push(line),
      broadcastCatalogReload: () => broadcasts.push(JSON.stringify({ type: "catalog/reload" })),
      refreshSnapshot: async () => {
        const catalog = await readCatalog(agentDir);
        snapshot = { HUB_WORKER_PROVIDERS: JSON.stringify({ providers: [], default: { provider: catalog.defaults.provider, model: catalog.defaults.model } }) };
      },
    },
  );
  return {
    commands,
    agentDir,
    snapshotEnv: () => snapshot,
    broadcasts,
    cleanup: async () => {
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}

describe("模型写命令 → catalog 快照与热更新（症状:保存模型后新线程/存量线程看不到新模型）", () => {
  test("models/add 成功后 snapshot 必须已刷新(含新模型)并向存量 worker 广播 catalog 更新", async () => {
    const h = await makeHost();
    const handled = await h.commands.handle({ type: "models/add", id: "m-x", provider: "prov-x", protocol: "openai", baseUrl: "https://x.example" } as never);
    expect(handled).toBe(true);
    const env = h.snapshotEnv();
    expect(env).toBeDefined();
    const catalog = await readCatalog(h.agentDir);
    expect(catalog.entries.some((e) => e.provider === "prov-x" && e.model === "m-x")).toBe(true);
    expect(h.broadcasts.some((line) => line.includes("catalog/reload"))).toBe(true);
  });

  test("models/remove 成功后 snapshot 必须刷新并广播", async () => {
    const h = await makeHost();
    await h.commands.handle({ type: "models/add", id: "m-x", provider: "prov-x", protocol: "openai", baseUrl: "https://x.example" } as never);
    h.broadcasts.length = 0;
    const handled = await h.commands.handle({ type: "models/remove", id: "m-x" } as never);
    expect(handled).toBe(true);
    expect(h.broadcasts.some((line) => line.includes("catalog/reload"))).toBe(true);
  });

  test("set_model_override 成功后 snapshot 必须刷新并广播", async () => {
    const h = await makeHost();
    const handled = await h.commands.handle({ type: "set_model_override", id: "r3", provider: "glm", modelId: "glm-5.3", contextWindow: 1_000_000 } as never);
    expect(handled).toBe(true);
    expect(h.snapshotEnv()).toBeDefined();
    expect(h.broadcasts.some((line) => line.includes("catalog/reload"))).toBe(true);
  });
});
