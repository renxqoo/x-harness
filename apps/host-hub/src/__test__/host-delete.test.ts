// thread/delete 状态矩阵（BATCH2-DESIGN §4）：活族拒（already open）/ parked|dead 撤表删 /
// 无表项删 / 幂等 / 子代理拒 / 活锁拒 / 死锁过 / symlink 逃逸拒 / 形状拒 / 级联子孙 /
// trash 残迹清扫 / rm 中途崩溃回收。真目录 + 真表，无进程依赖。
import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm as rmDir, symlink, utimes, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createThreadTable } from "../host/thread-table.ts";
import { deleteSession } from "../host/session-delete.ts";
import { cleanupTmpResidue } from "../host/tmp-sweep.ts";

async function fixture(): Promise<{ root: string; sessionsRoot: string; agentDir: string; table: ReturnType<typeof createThreadTable> }> {
  const root = await mkdtemp(join(tmpdir(), "hub-delete-"));
  const sessionsRoot = join(root, "sessions");
  const agentDir = join(root, "agent");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, sessionsRoot, agentDir, table: createThreadTable() };
}

async function makeSession(sessionsRoot: string, id: string, header: Record<string, unknown> = { id, createdAt: 1, cwd: "/w" }): Promise<void> {
  await mkdir(join(sessionsRoot, id), { recursive: true });
  await writeFile(join(sessionsRoot, id, "header.json"), JSON.stringify(header), "utf8");
  await writeFile(join(sessionsRoot, id, "events.jsonl"), `${JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } })}\n`, "utf8");
}

const pathOf = (root: string, id: string): string => join(root, "sessions", id, "events.jsonl");

describe("thread/delete 状态矩阵", () => {
  test("无表项存档：目录删除 + 幂等（二次 = success 且 removed 空）", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "arc1");
    const first = await deleteSession(f, pathOf(f.root, "arc1"));
    expect(first).toEqual({ ok: true, removed: ["arc1"] });
    await expect(stat(join(f.sessionsRoot, "arc1"))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await deleteSession(f, pathOf(f.root, "arc1"));
    expect(second).toEqual({ ok: true, removed: [] }); // 幂等
  });

  test("活族拒（already open，词表收敛复用——含活锁在场与目录缺席两形态）；parked/dead 撤表后删", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "t1");
    // 活锁在场（生产 live 形态——worker 持活 pid lock）：活族判定先于 lock 探活 → already open
    await writeFile(join(f.sessionsRoot, "t1", "lock"), `${process.pid}\n`, "utf8");
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: pathOf(f.root, "t1"), state: "live", trusted: false, keepalive: false });
    expect(await deleteSession(f, pathOf(f.root, "t1"))).toEqual({ ok: false, reason: "already open" });
    // 目录被外部 rm 但表项仍 live：不因缺席放行（worker 仍活——先 stop）
    f.table.insert({ threadId: "t0", cwd: "/w", sessionPath: pathOf(f.root, "t0"), state: "live", trusted: false, keepalive: false });
    expect(await deleteSession(f, pathOf(f.root, "t0"))).toEqual({ ok: false, reason: "already open" });
    f.table.remove("t1");
    await writeFile(join(f.sessionsRoot, "t1", "lock"), "999999999\n", "utf8"); // 活锁场景结束——死锁放行
    f.table.insert({ threadId: "t1", cwd: "/w", sessionPath: pathOf(f.root, "t1"), state: "parked", trusted: false, keepalive: false });
    expect(await deleteSession(f, pathOf(f.root, "t1"))).toEqual({ ok: true, removed: ["t1"] });
    expect(f.table.holderOf(pathOf(f.root, "t1"))).toBeUndefined(); // 表已撤
    await expect(stat(join(f.sessionsRoot, "t1"))).rejects.toMatchObject({ code: "ENOENT" });
    // dead 表项 + 目录在：同样撤表删
    await makeSession(f.sessionsRoot, "t2");
    f.table.insert({ threadId: "t2", cwd: "/w", sessionPath: pathOf(f.root, "t2"), state: "dead", trusted: false, keepalive: false });
    expect(await deleteSession(f, pathOf(f.root, "t2"))).toEqual({ ok: true, removed: ["t2"] });
  });

  test("幂等路径的表卫生：目录不在但表项残留 → 撤表 + success", async () => {
    const f = await fixture();
    f.table.insert({ threadId: "gone", cwd: "/w", sessionPath: pathOf(f.root, "gone"), state: "parked", trusted: false, keepalive: false });
    expect(await deleteSession(f, pathOf(f.root, "gone"))).toEqual({ ok: true, removed: [] });
    expect(f.table.holderOf(pathOf(f.root, "gone"))).toBeUndefined();
  });

  test("子代理会话拒删（header.agentId）；孤儿目录（无 header）可删", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "child1", { id: "child1", createdAt: 1, cwd: "/w", agentId: "agent-abc", parentSession: "p1" });
    expect(await deleteSession(f, pathOf(f.root, "child1"))).toEqual({ ok: false, reason: "cannot delete subagent session" });
    await mkdir(join(f.sessionsRoot, "orphan"), { recursive: true });
    await writeFile(join(f.sessionsRoot, "orphan", "lock.claim-123"), "x", "utf8");
    expect(await deleteSession(f, pathOf(f.root, "orphan"))).toEqual({ ok: true, removed: ["orphan"] }); // 垃圾目录连残迹清
  });

  test("活锁拒（本进程 pid）；死锁放行（连 lock 清）", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "locked");
    await writeFile(join(f.sessionsRoot, "locked", "lock"), `${process.pid}\n`, "utf8");
    expect(await deleteSession(f, pathOf(f.root, "locked"))).toEqual({ ok: false, reason: "session is locked by another process" });
    await writeFile(join(f.sessionsRoot, "locked", "lock"), "999999999\n", "utf8"); // 死 pid
    expect(await deleteSession(f, pathOf(f.root, "locked"))).toEqual({ ok: true, removed: ["locked"] });
  });

  test("围栏：相对路径拒 / 布局坏拒 / symlink 逃逸拒", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "ok1");
    expect((await deleteSession(f, "sessions/ok1/events.jsonl")).ok).toBe(false);
    expect((await deleteSession(f, join(f.root, "sessions", "ok1", "header.json"))).ok).toBe(false);
    const outside = await fixture();
    await makeSession(outside.sessionsRoot, "secret");
    await symlink(join(outside.sessionsRoot, "secret"), join(f.sessionsRoot, "sneaky"), "dir").catch(() => {});
    const sneaky = await deleteSession(f, pathOf(f.root, "sneaky"));
    expect(sneaky.ok).toBe(false); // realpath 逃逸拒——越权目录不可达
    await expect(stat(join(outside.sessionsRoot, "secret", "events.jsonl"))).resolves.toBeTruthy(); // 目标未被碰
  });

  test("级联：parentSession 血缘子孙一并删（隐形垃圾防线）", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "p");
    await makeSession(f.sessionsRoot, "c1", { id: "c1", createdAt: 1, cwd: "/w", agentId: "agent-1", parentSession: "p" });
    await makeSession(f.sessionsRoot, "g1", { id: "g1", createdAt: 1, cwd: "/w", agentId: "agent-2", parentSession: "c1" });
    await makeSession(f.sessionsRoot, "other", { id: "other", createdAt: 1, cwd: "/w", agentId: "agent-3", parentSession: "someone-else" });
    const result = await deleteSession(f, pathOf(f.root, "p"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.removed].sort()).toEqual(["c1", "g1", "p"]);
    await expect(stat(join(f.sessionsRoot, "other"))).resolves.toBeTruthy(); // 无血缘不动
  });

  test("trash 原子性：删除后 sessionsRoot 即刻干净；rm 尾 + 崩溃残迹由 tmp-sweep 回收", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "arc2");
    expect((await deleteSession(f, pathOf(f.root, "arc2"))).ok).toBe(true);
    // rm 异步尾——等它完成或人工造残迹后验证 sweep
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const trashDir = join(f.agentDir, "trash");
    const afterRm = await readdir(trashDir).catch(() => []);
    expect(afterRm).toEqual([]); // rm 已收尾
    // 崩溃残迹模拟：古 mtime 目录
    await mkdir(join(trashDir, "arc3.123.abc"), { recursive: true });
    await writeFile(join(trashDir, "arc3.123.abc", "x"), "x", "utf8");
    const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(trashDir, "arc3.123.abc"), ancient, ancient);
    await cleanupTmpResidue(f.agentDir);
    await expect(stat(join(trashDir, "arc3.123.abc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("删除后 resume 收敛：stat 无目录 → failure（有界失败链入口）", async () => {
    const f = await fixture();
    await makeSession(f.sessionsRoot, "gone2");
    await deleteSession(f, pathOf(f.root, "gone2"));
    // fence 对不存在路径放行（存在性由调用方 stat）——deleteSession 幂等面直接 success
    expect((await deleteSession(f, pathOf(f.root, "gone2"))).ok).toBe(true);
    // resume 路径的表/文件面：无表项 + 无目录 → host reserveResumeSlot stat 失败语义由
    // 既有测试覆盖；此处锚定 delete 幂等不复活表项
    expect(f.table.holderOf(pathOf(f.root, "gone2"))).toBeUndefined();
    void readFile;
    void rmDir;
  });
});
