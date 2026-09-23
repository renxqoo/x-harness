// bash 源测试（docs/TASKS.md §3 + docs/TASK-PUSH-DESIGN.md §2.1）：probe 会话键控 /
// stop 收敛终态非 mid-kill / 已终态 already finished / evict 竞态（读面归日志文件——
// 输出断言见 tool-bash log-sink/tasks 测试）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import type { SessionId } from "@x-harness/session";
import { BackgroundTasks, defaultTaskLimits } from "@x-harness/tool-bash";
import type { BackgroundTasks as BackgroundTasksType } from "@x-harness/tool-bash";
import { bashTaskSource } from "../source-bash.ts";

const sid = (v: string): SessionId => v as SessionId;
const SESSION = sid("bash-src");

let root: string;
let logRoot: string;
let env: ExecEnv;
let tasks: BackgroundTasksType;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-bashsrc-"));
  logRoot = mkdtempSync(join(tmpdir(), "xh-bashsrc-logs-"));
  env = createLocalEnv(root);
  tasks = new BackgroundTasks(defaultTaskLimits({ taskLogDir: logRoot }));
});

afterEach(() => {
  tasks.stopAll();
  rmSync(root, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

async function start(command: string, session: SessionId = SESSION): Promise<string> {
  const made = await tasks.start({ command, cwd: root, session, env });
  if (!made.ok) throw new Error(made.reason);
  return made.value.id;
}

const waitSettledOf = async (session: SessionId, id: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const snap = tasks.list(session).find((t) => t.id === id);
    if (snap === undefined || snap.endedAt !== undefined) return;
    if (Date.now() > deadline) throw new Error("settle timeout");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
};

describe("bash task source probe", () => {
  it("hits for the owning session and misses for another (session-scoped registry)", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 0.1");
    expect(source.probe(id, SESSION)).toEqual({ kind: "hit" });
    expect(source.probe(id, sid("other"))).toEqual({ kind: "miss" });
    expect(source.probe("t-doesnotexist", SESSION)).toEqual({ kind: "miss" });
  });
});

describe("bash task source stop", () => {
  it("settles before casting: terminal snapshot, no mid-kill tearing", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 30");
    const out = await source.stop(id, SESSION);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.text).toContain("Stopped");
    expect(out.text).toContain("killed");
    expect(out.text).not.toContain("mid-kill");
    expect(out.text).toMatch(/exit=(143|137)/); // settle 后可渲染退出码（TERM=143/KILL=137）——null 属未收敛
  });

  it("an already-finished task stops with the already finished prefix (no false Stopped)", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 0.05");
    await waitSettledOf(SESSION, id);
    const out = await source.stop(id, SESSION);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.text).toContain("already finished");
    expect(out.text).toContain("completed exit=0");
    expect(out.text).toContain("bytes="); // 状态行与通知首行同口径（bytes 在场）
  });

  it("a task evicted mid-stop resolves to not-found (unified fallback at the router)", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 30");
    tasks.evict(SESSION); // stop 前记录已消失——发起即 404
    const out = await source.stop(id, SESSION);
    expect(out).toEqual({ ok: false, reason: `not-found:${id}` });
  });

  it("a task evicted during the settle window falls through the snapshot fallback to not-found", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 30");
    const stopping = source.stop(id, SESSION);
    tasks.evict(SESSION); // 收敛窗内（waitSettled 首拍后）记录被逐出——settled=undefined 走 list 回落
    const out = await stopping;
    expect(out).toEqual({ ok: false, reason: `not-found:${id}` });
  });
});
