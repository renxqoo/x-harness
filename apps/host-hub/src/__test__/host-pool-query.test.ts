// worker-pool host→worker 内部查询面（plugins/list 装载态聚合的传输基元）：
// queryLiveWorkers 发出 internal id 命令、应答按 id 兑现、超时/worker 死亡容错、
// 无 live 会话空集。真进程行为由 plugins-loaded-status.test.ts 背书。
import { describe, expect, test } from "vitest";
import { makePool, until, wakeAndDeliver, wrote } from "./kit/pool-fixture.ts";

function responseLine(id: string, command: string, data: unknown): string {
  return `{"id":${JSON.stringify(id)},"type":"response","command":${JSON.stringify(command)},"success":true,"data":${JSON.stringify(data)}}`;
}

describe("queryLiveWorkers（内部查询面）", () => {
  test("无 live 会话：空集（不发命令）", async () => {
    const f = makePool();
    expect(await f.pool.queryLiveWorkers("get_plugins", 100)).toEqual([]);
    expect(f.spawned).toHaveLength(0);
  });

  test("live worker 应答按 internal id 兑现；应答不转发客户端", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g1", threadId: "t1" });
    const worker = f.spawned[f.spawned.length - 1];
    expect(worker).toBeDefined();

    const pending = f.pool.queryLiveWorkers("get_plugins", 5_000);
    await until(wrote(worker, '"get_plugins"'));
    // 应答行携带 internal id（@hub-internal: 前缀）——从写入行里解析回
    const sent = worker?.written.find((line) => line.includes('"get_plugins"')) ?? "";
    const internalId = (JSON.parse(sent) as { id: string }).id;
    expect(internalId.startsWith("@hub-internal:")).toBe(true);
    worker?.onLine(responseLine(internalId, "get_plugins", { loaded: [{ name: "token-analytics", mode: "process", status: "active" }] }));
    const results = await pending;
    expect(results).toEqual([{ loaded: [{ name: "token-analytics", mode: "process", status: "active" }] }] as unknown[]);
    // internal 应答不进客户端帧流
    expect(f.client.some((line) => line.includes("get_plugins"))).toBe(false);
  });

  test("超时：未应答以空兑现（results 不含该路）；等待表清理", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g1", threadId: "t1" });
    const started = Date.now();
    const results = await f.pool.queryLiveWorkers("get_plugins", 60);
    expect(results).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  test("worker 死亡：close 结算兑现等待者（空应答，不悬挂）", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g1", threadId: "t1" });
    const worker = f.spawned[f.spawned.length - 1];
    const pending = f.pool.queryLiveWorkers("get_plugins", 5_000);
    await until(wrote(worker, '"get_plugins"'));
    worker?.close();
    expect(await pending).toEqual([]);
  });

  test("多 live worker：各路独立应答聚合", async () => {
    const f = makePool();
    for (const tid of ["t1", "t2"]) {
      f.table.insert({ threadId: tid, cwd: "/w", sessionPath: `/hub/sessions/${tid}/events.jsonl`, state: "parked", trusted: false, keepalive: false });
      await wakeAndDeliver(f, { type: "get_state", id: `g-${tid}`, threadId: tid });
    }
    const workers = [...f.spawned];
    const pending = f.pool.queryLiveWorkers("get_plugins", 5_000);
    for (const worker of workers) {
      const sent = worker.written.find((line) => line.includes('"get_plugins"')) ?? "";
      const internalId = (JSON.parse(sent) as { id: string }).id;
      worker.onLine(responseLine(internalId, "get_plugins", { loaded: [{ name: `plugin-of-${worker.uid}`, mode: "worker", status: "active" }] }));
    }
    const results = (await pending) as Array<{ loaded: Array<{ name: string }> }>;
    const names: string[] = [];
    for (const reply of results) for (const row of reply.loaded) names.push(row.name);
    names.sort();
    expect(names).toHaveLength(2);
  });
});
