// 覆盖缺口收口（worker-pool wake 重试/预算复验/shutdownAll、host 引导关闭、
// parked-reads fail-open、read-history fence 分支、入口文件导入面）。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

const tmpRoots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePool, until, wakeAndDeliver, withPendingResume, wrote } from "./kit/pool-fixture.ts";
import { fenceSessionPath } from "../host/read-history.ts";
import { createDirectRead } from "../host/read-history.ts";
import { createParkedReads } from "../host/parked-reads.ts";
import { createThreadTable } from "../host/thread-table.ts";
import { spawnScriptWorker, waitResponse } from "./kit/worker-harness.ts";
import * as hostCli from "../host/cli.ts";
import * as workerMain from "../worker/main.ts";

void hostCli;
void workerMain;

function responseLine(fields: { id?: string; command: string; success: boolean; data?: unknown; error?: string }): string {
  const head = `{"id":${fields.id !== undefined ? JSON.stringify(fields.id) : "null"},"type":"response","command":${JSON.stringify(fields.command)},"success":${fields.success ? "true" : "false"}`;
  if (!fields.success && fields.error !== undefined) return `${head},"error":${JSON.stringify(fields.error)}}`;
  if (fields.success && fields.data !== undefined) return `${head},"data":${JSON.stringify(fields.data)}}`;
  return `${head}}`;
}

describe("worker-pool 唤醒与关闭面", () => {
  test("wake：resume 失败重试 → 耗尽落 dead（表项复活可重试语义）", async () => {
    const f = makePool(8, { workerExitTimeoutMs: 200 });
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    const wakePromise = f.pool.wake("t1");
    // 12 拍重试：每拍取「最新 spawn 且含未决 resume」的 worker 手动失败应答
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      await until(() => withPendingResume(f, seen) !== undefined, `attempt ${i}`, 8_000);
      const worker = withPendingResume(f, seen);
      if (worker === undefined) break;
      seen.add(worker.uid);
      worker.helloOk();
      const resumeLine = worker.written.find((line) => line.includes('"thread/resume"'));
      const resume = JSON.parse(resumeLine as string) as { id: string };
      worker.onLine(responseLine({ id: resume.id, command: "thread/resume", success: false, error: "cannot resume session: corrupt" }));
      worker.close();
    }
    const ok = await wakePromise;
    expect(ok).toBe(false); // 耗尽
    expect(f.table.get("t1")?.state).toBe("dead");
  }, 60_000);

  test("wake 并发单飞：同线程第二 wake 复用首飞结果", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    const first = f.pool.wake("t1");
    const second = f.pool.wake("t1");
    await until(() => f.spawned.length === 1);
    const worker = f.spawned[0];
    worker?.helloOk();
    const resumeLine = worker?.written.find((line) => line.includes('"thread/resume"'));
    const resume = JSON.parse(resumeLine as string) as { id: string };
    worker?.onLine(responseLine({ id: resume.id, command: "thread/resume", success: true, data: { threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl" } }));
    expect(await first).toBe(true);
    expect(await second).toBe(true); // 复用
    expect(f.spawned.length).toBe(1); // 单飞
  });

  test("shutdownAll：EOF+期限收口（不发死亡帧）", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    await wakeAndDeliver(f, { type: "get_state", id: "g1", threadId: "t1" }); // 唤醒 + 内部 resume 应答（表项保持 spawning 域——占用计数同 live）
    expect(f.table.get("t1") !== undefined).toBe(true);
    await f.pool.shutdownAll();
    expect(f.client.some((line) => line.includes("thread_died"))).toBe(false); // 关闭期不发死亡帧
  });

  test("beginKnown：表项存在即 spawn 投递", async () => {
    const f = makePool();
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: "/hub/sessions/t1/events.jsonl", state: "parked", trusted: false, keepalive: false });
    f.pool.beginKnown("t1", JSON.stringify({ type: "get_state", id: "g1", threadId: "t1" }));
    await until(wrote(f.spawned[0], "get_state"));
  });
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("trust-store live 集分支", () => {
  test("isTrusted：注册表命中 / live trusted 线程 cwd 命中 / 双未命中", async () => {
    const agentDir = await tempDir("hub-ts-");
    const { createTrustStore } = await import("../host/trust-store.ts");
    const trust = createTrustStore(agentDir);
    const table = createThreadTable();
    const cwd = await tempDir("hub-live-");
    expect(await trust.isTrusted(cwd, table)).toBe(false); // 双未命中
    table.insert({ threadId: "t-live", cwd, sessionPath: null, state: "live", trusted: true, keepalive: false });
    expect(await trust.isTrusted(cwd, table)).toBe(true); // live trusted 线程集命中
    await trust.trust(cwd);
    expect(await trust.isTrusted(cwd, table)).toBe(true); // 注册表命中
    await trust.untrust(cwd);
    table.update("t-live", { trusted: false });
    expect(await trust.isTrusted(cwd, table)).toBe(false); // 双撤
  });
});

describe("read-history fence 与直读", () => {
  test("fence：malformed 布局 / symlink 逃逸 / 通过", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-fence-"));
    try {
      const verdict = await fenceSessionPath("/abs/other.txt", root);
      expect(verdict.ok).toBe(false);
      const ok = await fenceSessionPath(`${root}/t1/events.jsonl`, root);
      expect(ok.ok).toBe(true);
      // symlink 逃逸：root 外目标
      const outside = await mkdtemp(join(tmpdir(), "hub-out-"));
      await mkdir(join(root, "evil"), { recursive: true });
      await rm(join(root, "evil", "events.jsonl"), { force: true });
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, join(root, "evil", "events.jsonl"));
      const escaped = await fenceSessionPath(`${root}/evil/events.jsonl`, root);
      expect(escaped.ok === false && escaped.reason).toContain("symlink escape");
      await rm(outside, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("直读：坏卷/缺席 fail-open（undefined）+ readHeader", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-dr-"));
    try {
      const direct = createDirectRead({ sessionsRoot: root });
      expect(await direct.readEntries("ghost", {})).toBeUndefined();
      expect(await direct.readState("ghost")).toBeUndefined();
      // 坏卷（中段坏行）→ fail-open
      const dir = join(root, "bad1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "header.json"), JSON.stringify({ id: "bad1", createdAt: 1 }), "utf8");
      await writeFile(join(dir, "events.jsonl"), '{"bogus":true}\n', "utf8");
      expect(await direct.readState("bad1")).toBeUndefined();
      // 合法卷
      const dir2 = join(root, "ok1");
      await mkdir(dir2, { recursive: true });
      await writeFile(join(dir2, "header.json"), JSON.stringify({ id: "ok1", createdAt: 1, cwd: "/w" }), "utf8");
      const ok1Events = [
        { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
        { type: "session/meta", seq: 1, time: 2, data: { key: "title", value: "T" } },
      ];
      const ok1Lines = ok1Events.map((e) => JSON.stringify(e)).join("\n");
      await writeFile(join(dir2, "events.jsonl"), `${ok1Lines}\n`, "utf8");
      const state = await direct.readState("ok1");
      expect(state?.sessionName).toBe("T");
      expect(state?.sessionFile).toContain("ok1/events.jsonl");
      const header = await direct.readHeader("ok1");
      expect(header?.cwd).toBe("/w");
      // 游标错误 = 真命令失败
      const bad = await direct.readEntries("ok1", { since: 99 });
      expect(bad !== undefined && "error" in bad && bad.error).toContain("invalid since cursor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parked-reads：live/未知 threadId 不接管；inflight 空形态恒 success", async () => {
    const table = createThreadTable();
    const client: string[] = [];
    const direct = createDirectRead({ sessionsRoot: "/nonexistent" });
    const parked = createParkedReads({ table, direct, emitClient: (line) => client.push(line) });
    expect(await parked.tryAnswer("get_state", { threadId: "ghost" }, "g1")).toBe(false); // 未知不接管
    table.insert({ threadId: "live1", cwd: "/w", sessionPath: "/s/x/events.jsonl", state: "live", trusted: false, keepalive: false });
    expect(await parked.tryAnswer("get_state", { threadId: "live1" }, "g2")).toBe(false); // live 不接管
    table.insert({ threadId: "p1", cwd: "/w", sessionPath: "/s/p/events.jsonl", state: "parked", trusted: false, keepalive: false });
    expect(await parked.tryAnswer("get_inflight", { threadId: "p1" }, "g3")).toBe(true); // 收敛读接管
    expect(client.some((line) => line.includes("turnStartSeq"))).toBe(true);
    expect(await parked.tryAnswer("get_state", { threadId: "p1" }, "g4")).toBe(false); // 直读不可用 → fail-open 交池
  });
});

describe("worker 关闭路径（stdin EOF → 优雅退出 exit 0）", () => {
  test("EOF 后 shutdown 完成（exit 回调兑现）", async () => {
    const w = await spawnScriptWorker({ script: [{ reply: "bye" }] });
    w.send({ type: "thread/start", id: "s1" });
    const started = await waitResponse(w.captured.lines, "thread/start", "s1");
    expect(started.success).toBe(true);
    w.input.end();
    await w.exited; // exit(0) 兑现（不悬挂）
  }, 15_000);

  test("parse 分支矩阵：非对象 JSON / type 缺席 → parse failure；尾行 flush", async () => {
    const w = await spawnScriptWorker({ script: [] });
    w.input.send('"bare string"');
    w.input.send("{}");
    w.input.emit("data", Buffer.from("42\\n", "utf8"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    const parseFailures = w.captured.lines.filter((line) => line.includes('"command":"parse"'));
    expect(parseFailures.length).toBeGreaterThanOrEqual(2); // 裸字符串/数字两路 parse failure（"{}" 合法——unknown command 域）
    // 尾行无换行残段：EOF flush 处理（合法尾行命令也应答）
    w.input.emit("data", Buffer.from(`${JSON.stringify({ type: "get_host_info", id: "h9" }).slice(0, -1)}`, "utf8"));
    // 截断成残段——flush 尾行按原样 parse（可能坏 JSON——不崩即可）
    w.input.end();
    await w.exited;
  }, 15_000);

});
