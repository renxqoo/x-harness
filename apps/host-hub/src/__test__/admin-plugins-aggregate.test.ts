// admin-commands plugins/list 装载态聚合（进程内）：pool 依赖注入面——
// live 快照并入 listPlugins 归并（active 优先合并/坏形状行丢弃/查询异常退化空表）。
// 真进程链理由 plugins-loaded-status.test.ts 背书。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdminCommands } from "../host/admin-commands.ts";
import { createThreadTable } from "../host/thread-table.ts";
import { createTrustStore } from "../host/trust-store.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  responses.length = 0;
});

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "admin-plg-"));
  tempDirs.push(dir);
  return dir;
}

const responses: Array<{ id?: string; command: string; result: { data?: unknown; error?: unknown } }> = [];

function makeAdmin(pool: { queryLiveWorkers(type: string, timeoutMs: number): Promise<unknown[]> } | undefined, agentDir: string) {
  const admin = createAdminCommands({
    agentDir,
    sessionsRoot: join(agentDir, "sessions"),
    table: createThreadTable(),
    trust: createTrustStore(agentDir),
    ...(pool !== undefined ? { pool } : {}),
    respond: (id, command, result) => {
      responses.push({ id, command, result });
    },
  });
  return admin;
}

describe("plugins/list 装载态聚合（admin-commands）", () => {
  it("pool 缺席：builtin 全 unloaded（无 live 会话语义）", async () => {
    const agentDir = await tempAgentDir();
    const admin = makeAdmin(undefined, agentDir);
    const handlers = new Map<string, (input: unknown, id?: string) => Promise<void>>();
    admin.register(handlers);
    await handlers.get("plugins/list")?.({}, "q1");
    const rows = ((responses[0] ?? { result: {} }).result.data as { plugins: Array<{ name: string; status: string }> }).plugins;
    expect(rows.find((row) => row.name === "token-analytics")?.status).toBe("unloaded");
  });

  it("pool 在场：快照并入——active 状态透传；failed 不遮他路 active", async () => {
    const agentDir = await tempAgentDir();
    const admin = makeAdmin({
      queryLiveWorkers: async (type) => {
        expect(type).toBe("get_plugins");
        return [
          { loaded: [{ name: "token-analytics", mode: "process", status: "active" }] },
          { loaded: [{ name: "token-analytics", mode: "process", status: "failed" }] },
        ];
      },
    }, agentDir);
    const handlers = new Map<string, (input: unknown, id?: string) => Promise<void>>();
    admin.register(handlers);
    await handlers.get("plugins/list")?.({}, "q2");
    const rows = ((responses[0] ?? { result: {} }).result.data as { plugins: Array<{ name: string; status: string }> }).plugins;
    expect(rows.find((row) => row.name === "token-analytics")?.status).toBe("active");
  });

  it("快照坏形状：行级丢弃（缺字段/非串）；应答缺 loaded 视空", async () => {
    const agentDir = await tempAgentDir();
    const admin = makeAdmin({
      queryLiveWorkers: async () => [
        { loaded: [{ name: "token-analytics", mode: "process" }, { name: 42, mode: "x", status: "y" }, "junk"] },
        { something: "else" },
      ],
    }, agentDir);
    const handlers = new Map<string, (input: unknown, id?: string) => Promise<void>>();
    admin.register(handlers);
    await handlers.get("plugins/list")?.({}, "q3");
    const rows = ((responses[0] ?? { result: {} }).result.data as { plugins: Array<{ name: string; status: string }> }).plugins;
    expect(rows.find((row) => row.name === "token-analytics")?.status).toBe("unloaded"); // 坏行全丢 → 快照空
  });

  it("查询异常：退化 unloaded 视图（不阻塞管理面）", async () => {
    const agentDir = await tempAgentDir();
    const admin = makeAdmin({ queryLiveWorkers: async () => Promise.reject(new Error("boom")) }, agentDir);
    const handlers = new Map<string, (input: unknown, id?: string) => Promise<void>>();
    admin.register(handlers);
    await handlers.get("plugins/list")?.({}, "q4");
    const rows = ((responses[0] ?? { result: {} }).result.data as { plugins: Array<{ name: string; status: string }> }).plugins;
    expect(rows.find((row) => row.name === "token-analytics")?.status).toBe("unloaded");
  });
});
