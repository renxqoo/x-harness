// bash 源测试（docs/TASKS.md §3）：probe 会话键控 / offset 增量连续 / block 语义（终态后切片、
// timeout=0 零等待、超时回乐观快照）/ stop 收敛终态非 mid-kill / 已终态 already finished / evict 竞态。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import type { ExecEnv } from "@x-harness/exec-env";
import type { SessionId } from "@x-harness/session";
import { BackgroundTasks, defaultTaskLimits } from "@x-harness/tool-bash";
import type { BackgroundTasks as BackgroundTasksType } from "@x-harness/tool-bash";
import { bashTaskSource, bashReadText } from "../source-bash.ts";

const sid = (v: string): SessionId => v as SessionId;
const SESSION = sid("bash-src");

let root: string;
let env: ExecEnv;
let tasks: BackgroundTasksType;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xh-bashsrc-"));
  env = createLocalEnv(root);
  tasks = new BackgroundTasks(defaultTaskLimits({}, { maxOutputBytes: 30_000, spillDir: root }));
});

afterEach(() => {
  tasks.stopAll();
  rmSync(root, { recursive: true, force: true });
});

async function start(command: string, session: SessionId = SESSION): Promise<string> {
  const made = await tasks.start({ command, cwd: root, session, env });
  if (!made.ok) throw new Error(made.reason);
  return made.value.id;
}

const nextOffsetOf = (text: string): number => {
  const hit = text.match(/nextOffset=(\d+)/);
  if (hit === null) throw new Error(`no nextOffset in: ${text}`);
  return Number(hit[1]);
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

describe("bash task source output", () => {
  it("block=true waits for the terminal state then slices (no torn tail)", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("printf 'partial'; sleep 0.2; printf '%s' '-tail'");
    const out = await source.output(id, SESSION, { block: true, timeout: 10_000 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.text).toContain("completed exit=0");
    expect(out.text).toContain("partial-tail");
    expect(out.text).toContain("more=false");
  });

  it("offset chains incrementally: nextOffset drives continuity", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 0.2; printf '0123456789'");
    await source.output(id, SESSION, { block: true, timeout: 10_000 });
    const whole = await source.output(id, SESSION, { block: false });
    if (!whole.ok) throw new Error(whole.reason);
    const mid = nextOffsetOf(whole.text) - 4; // 尾部 4 字节留给第二轮
    const rest = await source.output(id, SESSION, { block: false, offset: mid });
    if (!rest.ok) throw new Error(rest.reason);
    expect(rest.text).toContain("6789");
    expect(nextOffsetOf(rest.text)).toBe(nextOffsetOf(whole.text));
  });

  it("timeout=0 is a zero-wait immediate snapshot of a running task", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 1");
    const began = Date.now();
    const out = await source.output(id, SESSION, { block: true, timeout: 0 });
    expect(Date.now() - began).toBeLessThan(400);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("running exit=null");
  });

  it("block=true past its timeout returns the honest running snapshot", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 2");
    const out = await source.output(id, SESSION, { block: true, timeout: 60 });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("running exit=null");
  });

  it("reports the unified-eligible not-found after the session bucket is evicted", async () => {
    const source = bashTaskSource(tasks);
    const id = await start("sleep 0.05");
    tasks.evict(SESSION);
    const out = await source.output(id, SESSION, { block: false });
    expect(out).toEqual({ ok: false, reason: `not-found:${id}` }); // 路由层回落统一词表
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
    await source.output(id, SESSION, { block: true, timeout: 10_000 });
    const out = await source.stop(id, SESSION);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toContain("already finished");
      expect(out.text).toContain("completed exit=0");
    }
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

describe("bash read text casting", () => {
  it("caps the command head at 80 chars and carries spill hints", () => {
    const long = "x".repeat(120);
    const text = bashReadText({
      snapshot: { id: "t-aa", command: long, state: "failed", exitCode: 3, startedAt: 1, endedAt: 2, bytes: 4, truncated: true, spillPath: "/tmp/spill-1" },
      text: "body",
      nextOffset: 4,
      more: false,
    });
    expect(text).toContain(`t-aa (${"x".repeat(80)}…): failed exit=3 bytes=4`);
    expect(text).toContain("retention cap");
    expect(text).toContain("/tmp/spill-1");
    expect(text).toContain("nextOffset=4; more=false");
  });
});
