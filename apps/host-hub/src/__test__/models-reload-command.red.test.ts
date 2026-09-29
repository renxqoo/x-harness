import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostCommands } from "../host/host-commands.ts";
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
  reloads: () => number;
  refreshes: () => number;
  responses: () => string[];
}

async function makeHost(): Promise<Harness> {
  const agentDir = await tempRoot("hub-reload-");
  let reloads = 0;
  let refreshes = 0;
  const responses: string[] = [];
  const commands = createHostCommands(
    {
      table: { get: () => undefined, holderOf: () => undefined, liveCount: () => 0, list: () => [], remove: () => undefined, update: () => undefined } as never,
      pool: { liveThreadIds: () => [], deliverRaw: () => Promise.resolve() } as never,
      direct: {} as never,
      agentDir,
      sessionsRoot: join(agentDir, "sessions"),
      limits: { maxThreads: 4, idleRetireMs: 60_000, workerStaleMs: 60_000, workerExitTimeoutMs: 5_000, rssRetireBytes: 1 << 30, bashTimeoutMs: 30_000 },
      setLimits: () => undefined,
      emitClient: (line: string) => responses.push(line),
      startedAt: Date.now(),
      version: "test",
    },
    {
      broadcastToWorkers: () => undefined,
      broadcastCatalogReload: () => {
        reloads += 1;
      },
      refreshSnapshot: async () => {
        refreshes += 1;
      },
    },
  );
  return { commands, reloads: () => reloads, refreshes: () => refreshes, responses: () => responses };
}

describe("models/reload(症状:外部写者改 providers.json 后只能杀 host 重启——存量会话连坐中断)", () => {
  test("models/reload 触发快照刷新并向存量 worker 广播热更新,不重启 host", async () => {
    const h = await makeHost();
    const handled = await h.commands.handle({ type: "models/reload", id: "r1" } as never);
    expect(handled).toBe(true);
    expect(h.refreshes()).toBe(1);
    expect(h.reloads()).toBe(1);
    expect(h.responses().some((line) => line.includes("\"success\":true") && line.includes("models/reload"))).toBe(true);
  });

  test("models/reload 为 host 级命令:无 threadId 也可执行", async () => {
    const h = await makeHost();
    const handled = await h.commands.handle({ type: "models/reload" } as never);
    expect(handled).toBe(true);
    expect(h.refreshes()).toBe(1);
  });
});
