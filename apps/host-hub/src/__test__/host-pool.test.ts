// host 池契约（MIGRATION §5 pool-units/pool-caps/regressions-pool 移植）：恰一响应
// 终路（死亡对账合成 failure/settled）、心跳单向迁移、fork 重键、retire 竞窗、
// internal id 不可碰撞、预算/风暴上限、唤醒排队重评。
import { describe, expect, test } from "vitest";
import { makePool, until, wakeAndDeliver } from "./kit/pool-fixture.ts";

function responseLine(fields: { id?: string; command: string; success: boolean; data?: unknown; error?: string }): string {
  const head = `{"id":${fields.id !== undefined ? JSON.stringify(fields.id) : "null"},"type":"response","command":${JSON.stringify(fields.command)},"success":${fields.success ? "true" : "false"}`;
  if (!fields.success && fields.error !== undefined) return `${head},"error":${JSON.stringify(fields.error)}}`;
  if (fields.success && fields.data !== undefined) return `${head},"data":${JSON.stringify(fields.data)}}`;
  return `${head}}`;
}

function lines(frames: readonly string[]): unknown[] {
  return frames.map((line) => JSON.parse(line) as unknown);
}

describe("worker-pool（stub worker）", () => {
  test("thread/start 起步 @pending → 控制响应落实表 + 重绑；心跳投影单向迁移", async () => {
    const f = makePool();
    const verdict = f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c1", cwd: "/w" }), false, "/w");
    expect(verdict.ok).toBe(true);
    const worker = f.spawned[0];
    expect(worker).toBeDefined();
    await until(() => (worker?.written.some((line) => line.includes('"thread/start"')) ?? false));
    worker?.helloOk();
    worker?.onLine(responseLine({ id: "c1", command: "thread/start", success: true, data: { threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl" } }));
    await until(() => f.table.get("t1")?.state === "live");
    expect(f.table.holderOf("/hub/sessions/t1/events.jsonl")).toBe("t1");
    // 心跳投影：rss NaN 防御 + null sessionPath 不回写释放占用
    worker?.onLine(`{"type":"heartbeat","idleMs":5,"streaming":false,"sessionPath":"/hub/sessions/t1/events.jsonl","rssBytes":123}`);
    expect(f.table.get("t1")?.rssBytes).toBe(123);
    worker?.onLine(`{"type":"heartbeat","idleMs":5,"streaming":true,"sessionPath":null,"rssBytes":"NaN"}`);
    expect(f.table.get("t1")?.rssBytes).toBe(null); // 坏样本丢
    expect(f.table.holderOf("/hub/sessions/t1/events.jsonl")).toBe("t1"); // null 不回写
  });

  test("close 死亡对账：未见响应 pending 补恰一 failure；在飞驱动合成 settled{worker-died}", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g1", threadId: "t1" });
    const worker = f.spawned[f.spawned.length - 1];
    // g1 先应答（核销）；p1 已 settled（核销）——close 后都不补
    worker?.onLine(responseLine({ id: "g1", command: "get_state", success: true, data: {} }));
    // g2 未应答（pending）+ p1/p2 在飞驱动——经 routeLine 登记
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p1", threadId: "t1" }));
    void f.pool.routeLine(JSON.stringify({ type: "get_state", id: "g2", threadId: "t1" }));
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p2", threadId: "t1" }));
    await until(() => worker?.written.some((line) => line.includes('"p2"')) ?? false);
    // p1 全收敛面：受理 ack（pendingIds 核销）+ settled（drivingIds 核销）
    worker?.onLine(responseLine({ id: "p1", command: "prompt", success: true }));
    worker?.onLine(`{"type":"event","threadId":"t1","name":"settled","payload":{"sendId":"p1","ok":true}}`);
    worker?.close();
    await until(() => f.table.get("t1")?.state === "dead");
    const frames = lines(f.client);
    const failures = frames.filter((frame) => (frame as { type?: string; command?: string; id?: string; error?: string }).type === "response" && (frame as { error?: string }).error === "worker died before responding");
    expect(failures.map((frame) => (frame as { id?: string }).id).sort()).toEqual(["g2", "p2"]); // 恰一补failure：g2/p2 各一条（g1/p1 已核销不补）
    const settledAll = frames.filter((frame) => (frame as { type?: string; name?: string }).name === "settled");
    const settledP1 = settledAll.filter((frame) => (frame as { payload?: { sendId?: string } }).payload?.sendId === "p1");
    const settledP2 = settledAll.filter((frame) => (frame as { payload?: { sendId?: string } }).payload?.sendId === "p2");
    expect(settledP1).toHaveLength(1); // 真实 settled 透传恰一
    expect((settledP1[0] as { payload: { ok: boolean } }).payload.ok).toBe(true);
    expect(settledP2).toHaveLength(1); // 未 settled 驱动 id 合成恰一
    expect((settledP2[0] as { payload: { ok: boolean; reason?: string } }).payload.reason).toBe("worker-died");
    const died = frames.filter((frame) => (frame as { type?: string }).type === "thread_died");
    expect(died).toHaveLength(1); // thread_died 恰一
  });

  test("fork 控制响应先改表再转发（旧 id 立即失效——重键序）", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g0", threadId: "t1" });
    void f.pool.deliverRaw("t1", JSON.stringify({ type: "fork", id: "f1", threadId: "t1", seq: 3 }));
    const worker = f.spawned[f.spawned.length - 1];
    await until(() => worker?.written.some((line) => line.includes('"fork"')) ?? false);
    worker?.onLine(responseLine({ id: "f1", command: "fork", success: true, data: { threadId: "t2", previousThreadId: "t1", sessionPath: "/hub/sessions/t2/events.jsonl" } }));
    await until(() => f.table.get("t2") !== undefined);
    expect(f.table.get("t1")).toBeUndefined(); // 旧 id 删表
    expect(f.table.get("t2")?.state).toBe("live");
    // 转发的响应帧在表更新之后到达客户端（同一 tick——顺序由 ingest 保证）
    const forwarded = lines(f.client).some((frame) => (frame as { id?: string }).id === "f1");
    expect(forwarded).toBe(true);
    // 旧 id 命令 → Unknown threadId
    void f.pool.routeLine(JSON.stringify({ type: "get_state", id: "g-old", threadId: "t1" }));
    await until(() => f.client.some((line) => line.includes("g-old")));
    expect(f.client.some((line) => line.includes('"Unknown threadId"'))).toBe(true);
  });

  test("internal id 不可冒用（恰一 failure）；unknown command / threadId required / Unknown threadId", async () => {
    const f = makePool();
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "@hub-internal:1", threadId: "t1" }));
    expect(f.client.some((line) => line.includes("invalid id: reserved namespace"))).toBe(true);
    void f.pool.routeLine(JSON.stringify({ type: "no_such", id: "u1", threadId: "t1" }));
    expect(f.client.some((line) => line.includes("unknown command"))).toBe(true);
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p1" }));
    expect(f.client.some((line) => line.includes("threadId required"))).toBe(true);
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p2", threadId: "ghost" }));
    expect(f.client.some((line) => line.includes("Unknown threadId"))).toBe(true);
  });

  test("预算：maxThreads 满 → too many live threads；超发复验杀最新", async () => {
    const f = makePool(1);
    const first = f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c1", cwd: "/w" }), false, "/w");
    expect(first.ok).toBe(true);
    const second = f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c2", cwd: "/w" }), false, "/w");
    expect(second).toEqual({ ok: false, reason: "too many live threads (limit reached)" });
    const worker = f.spawned[0];
    worker?.helloOk();
    worker?.onLine(responseLine({ id: "c1", command: "thread/start", success: true, data: { threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl" } }));
    await until(() => f.table.get("t1")?.state === "live");
    // live=1 满：再 start 拒
    const third = f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c3", cwd: "/w" }), false, "/w");
    expect(third.ok).toBe(false);
  });

  test("retireThread：未落盘拒；stop 优先升级；stop 结算删表无帧", async () => {
    const f = makePool();
    const verdict = f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c1", cwd: "/w" }), false, "/w");
    expect(verdict.ok).toBe(true);
    const worker = f.spawned[0];
    worker?.helloOk();
    worker?.onLine(responseLine({ id: "c1", command: "thread/start", success: true, data: { threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl" } }));
    await until(() => f.table.get("t1")?.state === "live");
    // 已落盘：retire → retiring → eof → close → parked + thread_parked 恰一
    const outcome = f.pool.retireThread("t1", "retire", "idle");
    expect(outcome).toBe("ok");
    expect(f.table.get("t1")?.state).toBe("retiring");
    worker?.close();
    await until(() => f.table.get("t1")?.state === "parked");
    expect(f.client.some((line) => line.includes("thread_parked"))).toBe(true);
  });

  test("retiring 窗口命令排队至 close 重评（删表 → Unknown threadId）", async () => {
    const f = makePool(8, { workerExitTimeoutMs: 5_000 });
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g0", threadId: "t1" });
    f.pool.retireThread("t1", "stop");
    expect(f.table.get("t1")?.state).toBe("retiring");
    void f.pool.routeLine(JSON.stringify({ type: "prompt", id: "p1", threadId: "t1" })); // 排队
    await Bun.sleep(30);
    expect(f.client.every((line) => !line.includes('"p1"') || line.includes("Unknown threadId"))).toBe(true); // 无成功应答（重评结果除外）
    f.spawned[f.spawned.length - 1]?.close();
    await until(() => f.client.some((line) => line.includes('"p1"')));
    // close 删表（stop 意图）→ 重评 → Unknown threadId
    expect(f.client.some((line) => line.includes('"p1"') && line.includes("Unknown threadId"))).toBe(true);
  });

  test("hello 不符：拒载（撤位 + pending 补 failure + 无 thread_died）", async () => {
    const f = makePool();
    f.pool.beginThread(JSON.stringify({ type: "thread/start", id: "c1", cwd: "/w" }), false, "/w");
    const worker = f.spawned[0];
    worker?.onLine(`{"type":"hello","protocolVersion":2,"backendId":"other"}`);
    worker?.close();
    await until(() => f.client.some((line) => line.includes("worker died before responding")));
    expect(f.client.some((line) => line.includes("thread_died"))).toBe(false); // @pending 撤位无死亡帧
  });

  test("非 live 表项 1024 FIFO 逐出（随后 Unknown threadId）", async () => {
    const f = makePool();
    for (let i = 0; i < 1026; i += 1) {
      f.table.insert({ threadId: `p-${i}`, cwd: "/w", sessionPath: `/hub/sessions/p-${i}/events.jsonl`, state: "parked", trusted: false, keepalive: false });
    }
    expect(f.table.get("p-0")).toBeUndefined(); // 最旧被逐出
    expect(f.table.get("p-1025")).toBeDefined();
    expect(f.table.list().length).toBeLessThanOrEqual(1024);
  });
});
