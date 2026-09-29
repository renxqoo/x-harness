import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { PathGate } from "@x-harness/tool-core";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createBashPlugin } from "../plugin.ts";
import { BackgroundTasks, defaultTaskLimits, type TaskSnapshot } from "../tasks.ts";

let root: string;
let registry: ToolRegistry;
let disposers: Array<() => Promise<void>> = [];
let spillDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-bash-"));
  spillDir = mkdtempSync(join(tmpdir(), "xh-spill-"));
  const gate = new PathGate(root);
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, createBashPlugin({ gate, env: createLocalEnv(root), limits: { spillDir, defaultTimeoutMs: 3_000 } })]);
  registry = ctx.use(toolRegistry);
  disposers.push(async () => {
    await ctx.dispose();
    void unload;
  });
});

afterEach(async () => {
  for (const fn of disposers) await fn().catch(() => {});
  disposers = [];
  rmSync(root, { recursive: true, force: true });
  rmSync(spillDir, { recursive: true, force: true });
});

let counter = 0;
const bash = (args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError?: true }> =>
  registry.dispatch({ callId: `b${String((counter += 1))}`, name: "bash", args, signal: signal ?? new AbortController().signal });

describe("bash（docs/TOOLBOX.md §4——交集 11 条）", () => {
  it("退出码可见且非 isError；成功静默 → (no output)；stdout 到场", async () => {
    const fail = await bash({ command: "echo out; exit 3" });
    expect(fail.isError).toBeUndefined();
    expect(fail.content).toContain("out");
    expect(fail.content).toContain("[exit code: 3]");
    const silent = await bash({ command: "true" });
    expect(silent.content).toContain("(no output)");
    const ok = await bash({ command: "printf hello" });
    expect(ok.content).toContain("hello");
    expect(ok.content).toContain("[exit code: 0]");
  });

  it("stderr 分节 [stderr]；ANSI 清洗", async () => {
    const r = await bash({ command: "printf 'err-out' >&2" });
    expect(r.content).toContain("[stderr]");
    expect(r.content).toContain("err-out");
    const ansi = await bash({ command: "printf '\\033[31mred\\033[0m\\n'" });
    expect(ansi.content).toContain("red");
    expect(ansi.content).not.toContain("\\033");
    expect(ansi.content).not.toContain("[31m");
  });

  it("超时两段杀：[timed out] + raise timeout 指引；trap-exit-0 不伪装成功（回归 D23）", async () => {
    const r = await bash({ command: "trap 'exit 0' TERM; sleep 30", timeout: 300 });
    expect(r.content).toContain("[timed out after 300ms]");
    expect(r.content).toContain("raise timeout");
    expect(r.content).not.toMatch(/\[exit code: 0\]\s*$/);
  }, 15_000);

  it("timeout 校验表：0/负/超 maxTimeoutMs 拒绝", async () => {
    for (const bad of [0, -1, 600_001]) {
      const r = await bash({ command: "true", timeout: bad });
      expect(r.isError, String(bad)).toBe(true);
    }
  });

  it("截断保尾部三件套：标注在场+尾部内容在场+spill 字节级等于全文（审查 B-P2）", async () => {
    const r = await bash({ command: "seq 1 100000" });
    expect(r.content).toContain("[output truncated; full output:");
    expect(r.content).toContain("100000");
    const spill = r.content.match(/full output: ([^\]\s]+)/)?.[1];
    expect(spill).toBeDefined();
    const expected = Buffer.from(`${Array.from({ length: 100_000 }, (_, i) => String(i + 1)).join("\n")}\n`);
    expect(readFileSync(spill as string).equals(expected)).toBe(true);
    const shown = r.content.split("\n").filter((line) => /^\d+$/.test(line));
    expect(shown.length).toBeLessThanOrEqual(2_000);
    expect(shown[0]).not.toBe("1");
  }, 20_000);

  it("撕裂 UTF-8：跨 chunk 多字节字符解码正确（无替换符）；多字节超帽截断必收敛（回归：字节校验循环死循环 99% CPU）", async () => {
    const r = await bash({ command: "printf '€%.0s' $(seq 1 20000)" });
    expect(r.content).not.toContain("�");
    expect(r.content).toContain("€");
    const emoji = await bash({ command: "printf '😀%.0s' $(seq 1 20000)" });
    expect(emoji.content).not.toContain("�");
    expect(emoji.content).toContain("😀");
    expect(emoji.content).toContain("[output truncated");
  }, 20_000);

  it("abort 杀整组（回归进程泄漏）：组探活断言", async () => {
    const controller = new AbortController();
    const promise = bash({ command: "sleep 30 & sleep 30; wait" }, controller.signal);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    controller.abort();
    const r = await promise;
    expect(r.content.toLowerCase()).toContain("abort");
  }, 10_000);

  it("回归（进程泄漏）：abort/超时后无存活子进程（marker 文件法 + 墙钟）", async () => {
    const marker = join(root, "alive-marker");
    const started = Date.now();
    await bash({ command: `(sleep 2; touch after-kill) & while true; do :; done; true`, timeout: 300 });
    expect(Date.now() - started).toBeLessThan(8_000);
    await new Promise((resolve) => {
      setTimeout(resolve, 2_500);
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "after-kill"))).toBe(false);
  }, 15_000);

  it("pre-abort 零 spawn（回归 D28）：marker 文件不出现", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await bash({ command: `touch ${join(root, "spawned")}` }, controller.signal);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("aborted");
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    expect(existsSync(join(root, "spawned"))).toBe(false);
  });

  it("命令含 NUL 拒绝；信号死退出码可见（137）", async () => {
    const nul = await bash({ command: "a\u0000b" });
    expect(nul.content).toContain("NUL_IN_ARGUMENT");
    const killed = await bash({ command: "kill -9 $$" });
    expect(killed.content).toContain("[exit code: 137]");
  });

  it("回归（超时误报）：速死命令不被迟到调度误判超时——退出码可见（137）", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await bash({ command: "kill -9 $$" });
      expect(r.content).not.toContain("timed out");
      expect(r.content).toContain("[exit code: 137]");
    }
  }, 20_000);

  it("回归（超时误报）：后台任务外部 SIGKILL 死因不冒充 timed-out", async () => {
    const tasks = new BackgroundTasks(defaultTaskLimits({ taskLogDir: spillDir, taskTimeoutMs: 10_000 }));
    try {
      const started = await tasks.start({ command: "sleep 60", cwd: root, session: undefined, env: createLocalEnv(root) });
      if (!started.ok) throw new Error(started.reason);
      const settlePromise = new Promise<TaskSnapshot>((resolve) => {
        const unsub = tasks.onSettled((snap) => {
          if (snap.id === started.value.id) { unsub(); resolve(snap); }
        });
      });
      await new Promise((r) => { setTimeout(r, 300); });
      const exec = (await import("node:util")).promisify((await import("node:child_process")).execFile);
      await exec("pkill", ["-9", "-f", "sleep 60"]);
      const snap = await settlePromise;
      expect(snap.state).not.toBe("timed-out");
      expect(snap.exitCode).toBe(137);
    } finally {
      tasks.stopAll();
    }
  }, 15_000);

  it("大输出场景双流不堵管：stdout+stderr 同发完成（防死锁假挂）", async () => {
    const r = await bash({ command: "seq 1 20000 >&1; seq 1 20000 >&2; echo done" });
    expect(r.content).toContain("done");
    expect(r.content).toContain("[stderr]");
  }, 20_000);
});

describe("回归（审查 A-P1）：组长速死孙进程——组探活不提前除名", () => {
  it("组长退出但孙进程活 → settleGroup 等净（marker 不出现）且工具收敛 <10s", async () => {
    const marker = join(root, "grandchild-marker");
    const started = Date.now();
    const r = await bash({ command: `sh -c 'trap "" TERM; sleep 6; touch ${marker}' >/dev/null 2>&1 & exit 0`, timeout: 500 });
    expect(r.content).toContain("[exit code: 0]");
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((resolve) => {
      setTimeout(resolve, 6_500);
    });
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("普通 [INFO] 文本不被 ANSI 清洗啃噬（锚定 ESC 回归）", async () => {
    const r = await bash({ command: "echo '[INFO] message [note] tail'" });
    expect(r.content).toContain("[INFO] message [note] tail");
  });
});

describe("host-exit 清场（审查 B-P1：真子进程验证，非注册簿自检）", () => {
  it("宿主进程退出 → 活组被 exit handler SIGKILL（marker 不出现）", async () => {
    const marker = join(root, "leak-marker");
    const script = join(root, "host-exit-runner.ts");
    const repo = resolve(import.meta.dirname, "../../../..");
    writeFileSync(
      script,
      [
        `import { createContext, loadPlugins } from ${JSON.stringify(join(repo, "packages/core/context/src/index.ts"))};`,
        `import { toolsPlugin, toolRegistry } from ${JSON.stringify(join(repo, "packages/core/tools/src/index.ts"))};`,
        `import { createLocalEnv } from ${JSON.stringify(join(repo, "packages/core/exec-env/src/local/env.ts"))};\nimport { PathGate } from ${JSON.stringify(join(repo, "packages/tool-core/src/paths.ts"))};\nimport { createBashPlugin } from ${JSON.stringify(join(repo, "packages/tool-bash/src/plugin.ts"))};`,
        `const ctx = createContext();`,
        `const gate = new PathGate(${JSON.stringify(root)});`,
        `const unload = await loadPlugins(ctx, [toolsPlugin, createBashPlugin({ gate, env: createLocalEnv(${JSON.stringify(root)}) })]);`,
        `const reg = ctx.use(toolRegistry);`,
        `void reg.dispatch({ callId: "host-exit", name: "bash", args: { command: ${JSON.stringify(`sleep 3; touch ${marker}`)}, timeout: 30000 }, signal: new AbortController().signal }).catch(() => {});`,
        `setTimeout(() => process.exit(0), 800); // spawn 已发生、dispatch 未收敛——宿主退出走清场`,
        `void unload;`,
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const code = await child.exited;
    expect(code).toBe(0);
    await new Promise((resolve) => {
      setTimeout(resolve, 3_500);
    });
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("bash 排他（缺省 exclusive——fail-closed）", async () => {
    expect(registry.concurrencyOf("bash", {})).toBe("exclusive");
  });
});

describe("装配期 fail-closed（收口审查 P1：tasks/taskLimits 同传曾静默忽略）", () => {
  it("tasks 与 taskLimits 同传 → throw（装配矛盾拒绝，不静默取一）", () => {
    const gate = new PathGate(root);
    const tasks = new BackgroundTasks(defaultTaskLimits({ taskLogDir: spillDir }));
    expect(() => createBashPlugin({ gate, tasks, taskLimits: { taskTimeoutMs: 1_000 } })).toThrow(/not both/);
  });

  it("taskLimits 非法值 → 装配期 throw（校验不因缺省链缺席）", () => {
    const gate = new PathGate(root);
    expect(() => createBashPlugin({ gate, taskLimits: { taskTimeoutMs: -1 } })).toThrow(/taskTimeoutMs/);
    expect(() => createBashPlugin({ gate, taskLimits: { maxConcurrentTasks: 0 } })).toThrow(/maxConcurrentTasks/);
  });
});
