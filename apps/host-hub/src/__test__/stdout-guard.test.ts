// stdout-guard 契约（MIGRATION §5 stdout-guard 块移植 + 重试上限降级锚）：
// 注入 fake write——串行不交错、ENOBUFS 重试有上限后降级、EPIPE 终态回调。
import { describe, expect, test } from "vitest";
import { takeOverStdout } from "../shared/stdout-guard.ts";

function fakeStdout(script: Array<(line: string) => { err?: Error }>) {
  const written: string[] = [];
  let call = 0;
  const write = (line: string, _enc: string, cb: (err?: Error | null) => void): boolean => {
    written.push(line);
    const step = script[Math.min(call, script.length - 1)] ?? ((): { err?: Error } => ({}));
    call += 1;
    const { err } = step(line);
    queueMicrotask(() => cb(err ?? null));
    return true;
  };
  return { written, write };
}

type ConsoleLevels = Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>;

/** console 方法绑定快照（takeOverStdout 会改写——测试后按快照恢复） */
function snapshotConsole(): ConsoleLevels {
  const con = console;
  const levels: ConsoleLevels = {
    log: con.log.bind(con),
    info: con.info.bind(con),
    warn: con.warn.bind(con),
    error: con.error.bind(con),
    debug: con.debug.bind(con),
  };
  return levels;
}

function patchStdout(write: unknown): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = write;
  return () => {
    (process.stdout as { write: unknown }).write = orig;
  };
}

function patchStderr(sink: (chunk: string) => void): () => void {
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    sink(String(chunk));
    return true;
  };
  return () => {
    (process.stderr as { write: unknown }).write = orig;
  };
}

describe("stdout-guard", () => {
  test("串行写不交错（帧间顺序严格）", async () => {
    const fake = fakeStdout([]);
    const restore = patchStdout(fake.write);
    try {
      const w = takeOverStdout();
      await Promise.all([w.write("a"), w.write("b"), w.write("c")]);
      expect(fake.written).toEqual(["a\n", "b\n", "c\n"]);
      expect(w.dropped()).toBe(0);
    } finally {
      restore();
    }
  });

  test("ENOBUFS 暂态重试后成功", async () => {
    let n = 0;
    const fake = fakeStdout([
      () => ({ err: Object.assign(new Error("full"), { code: "ENOBUFS" }) }),
      () => ((n = 1), {}),
    ]);
    const restore = patchStdout(fake.write);
    try {
      const w = takeOverStdout({ retryDelayMs: 1 });
      await w.write("frame");
      expect(n).toBe(1);
      expect(w.dropped()).toBe(0);
    } finally {
      restore();
    }
  });

  test("持续 ENOBUFS：重试上限后降级丢帧 + stderr 记录（活锁回归锚）", async () => {
    const fake = fakeStdout([() => ({ err: Object.assign(new Error("full"), { code: "ENOBUFS" }) })]);
    const restore = patchStdout(fake.write);
    try {
      const w = takeOverStdout({ retryMax: 3, retryDelayMs: 1 });
      await w.write("doomed");
      expect(w.dropped()).toBe(1);
      expect(fake.written.length).toBe(4); // 1 次首试 + 3 次重试，随后降级
    } finally {
      restore();
    }
  });

  test("EPIPE 终态：触发 onBroken 不再重试", async () => {
    let broken = 0;
    const fake = fakeStdout([() => ({ err: Object.assign(new Error("gone"), { code: "EPIPE" }) })]);
    const restore = patchStdout(fake.write);
    try {
      const w = takeOverStdout({ onBroken: () => (broken += 1) });
      await w.write("x");
      expect(broken).toBe(1);
      expect(fake.written.length).toBe(1);
      expect(w.dropped()).toBe(0); // EPIPE 是退出路径不是丢帧
    } finally {
      restore();
    }
  });

  test("idle()：未 await 的已入队帧在 idle 尾部全部落盘（退出前冲刷）", async () => {
    const fake = fakeStdout([]);
    const restore = patchStdout(fake.write);
    try {
      const w = takeOverStdout();
      void w.write("f1"); // 不逐帧 await
      void w.write("f2");
      void w.write("f3");
      await w.idle();
      expect(fake.written).toEqual(["f1\n", "f2\n", "f3\n"]);
    } finally {
      restore();
    }
  });

  test("杂散改道：console.* 与非帧 stdout 直写全部落 stderr（不污染帧管道）", async () => {
    const fake = fakeStdout([]);
    const restore = patchStdout(fake.write);
    const stderrChunks: string[] = [];
    const restoreErr = patchStderr((chunk) => stderrChunks.push(chunk));
    const con = console;
    const origConsole = snapshotConsole();
    try {
      const w = takeOverStdout();
      con.log("frame-leak", 42);
      con.error("boom");
      process.stdout.write("stray library write\n");
      await w.idle();
      expect(stderrChunks).toContain("log: frame-leak 42\n");
      expect(stderrChunks).toContain("error: boom\n");
      expect(stderrChunks).toContain("stray library write\n");
      expect(fake.written).toEqual([]); // 杂散绝不进帧管道（stdout 只剩协议帧）
    } finally {
      restore();
      restoreErr();
      Object.assign(console, origConsole);
    }
  });

  test("协议帧形态的 stdout 直写：拦截入队保持串行（不落 stderr）", async () => {
    const fake = fakeStdout([]);
    const restore = patchStdout(fake.write);
    const stderrChunks: string[] = [];
    const restoreErr = patchStderr((chunk) => stderrChunks.push(chunk));
    const origConsole = snapshotConsole();
    try {
      const w = takeOverStdout();
      const frame = '{"type":"event","threadId":"t1","name":"x"}';
      expect((process.stdout.write as (chunk: unknown) => boolean)(`${frame}\n`)).toBe(true);
      await w.idle();
      expect(fake.written).toEqual([`${frame}\n`]); // 换行剥离后入队、写回时补齐
      expect(stderrChunks).toEqual([]);
    } finally {
      restore();
      restoreErr();
      Object.assign(console, origConsole);
    }
  });
});
