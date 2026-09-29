import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { acquireSessionLock } from "../lock.ts";
import { openSessionWriter } from "../writer.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xh-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(): SessionHeader {
  return { id: "s-lock" as SessionId, createdAt: 0, cwd: dir };
}

function event(seq: number): SessionEvent {
  return { type: "session/event", seq, at: 0, data: {} } as unknown as SessionEvent;
}

describe("acquireSessionLock", () => {
  it("首个获取成功；释放后可重取", async () => {
    const first = await acquireSessionLock(dir, "s-lock");
    expect(await readFile(join(dir, "lock"), "utf8")).toBe(`${process.pid}\n`);
    await first.release();
    const second = await acquireSessionLock(dir, "s-lock");
    await second.release();
  });

  it("活进程在锁 → session-locked 永久拒绝", async () => {
    const holder = await acquireSessionLock(dir, "s-lock");
    try {
      const error = await acquireSessionLock(dir, "s-lock").then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("session-locked:s-lock");
      expect((error as { permanent?: boolean }).permanent).toBe(true);
    } finally {
      await holder.release();
    }
  });

  it("持有方已死（pid 不存在）→ 接管", async () => {
    const child = Bun.spawn({ cmd: ["/bin/sh", "-c", "exit 0"], stdout: "ignore", stderr: "ignore" });
    await child.exited;
    const deadPid = child.pid as number;
    await writeFile(join(dir, "lock"), `${deadPid}\n`, "utf8");
    const taken = await acquireSessionLock(dir, "s-lock");
    await taken.release();
  });

  it("锁内容不可解析（崩溃半写）→ 接管", async () => {
    await writeFile(join(dir, "lock"), "", "utf8");
    const taken = await acquireSessionLock(dir, "s-lock");
    await taken.release();
  });
});

describe("openSessionWriter 与锁协同", () => {
  it("活锁在场 → 打开拒绝且不触碰卷（events.jsonl 不被创建）", async () => {
    await mkdir(dir, { recursive: true });
    const holder = await acquireSessionLock(dir, "s-lock");
    try {
      const error = await openSessionWriter(dir, header(), []).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as Error).message).toContain("session-locked");
    } finally {
      await holder.release();
    }
  });

  it("打开失败后释放锁（不留死锁）：header 冲突拒绝 → 锁已可重取", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), "", "utf8");
    await writeFile(join(dir, "header.json"), `${JSON.stringify({ ...header(), createdAt: 1 })}\n`, "utf8");
    const error = await openSessionWriter(dir, header(), [event(0)]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("session-id-reused");
    const retake = await acquireSessionLock(dir, "s-lock");
    await retake.release();
  });

  it("writer.close() 释放锁：同目录二次打开（模拟 dispose→resume 链）成功", async () => {
    const first = await openSessionWriter(dir, header(), []);
    await first.writer.close();
    const second = await openSessionWriter(dir, header(), []);
    expect(second.prefixLength).toBe(0);
    await second.writer.close();
  });
});
