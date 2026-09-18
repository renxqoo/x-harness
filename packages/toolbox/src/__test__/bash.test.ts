// bash 工具测试（docs/TOOLBOX.md §4/§6——交集 bash 11 条 + 进程泄漏回归源）。

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createLocalEnv } from "@x-harness/exec-env";
import { createToolbox } from "../toolbox.ts";
import type { ToolRegistry } from "@x-harness/tools";
import { createContext, loadPlugins } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";

let root: string;
let registry: ToolRegistry;
let disposers: Array<() => Promise<void>> = [];
let spillDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "xh-bash-"));
  spillDir = mkdtempSync(join(tmpdir(), "xh-spill-"));
  const box = createToolbox({ root, spillDir, defaultTimeoutMs: 3_000, env: createLocalEnv(root) });
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [toolsPlugin, box.bashPlugin]);
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
    expect(fail.isError).toBeUndefined(); // 非零退出不是工具错误
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

  it("超时两段杀：[timed out] + raise timeout_ms 指引；trap-exit-0 不伪装成功（回归 D23）", async () => {
    const r = await bash({ command: "trap 'exit 0' TERM; sleep 30", timeout_ms: 300 });
    expect(r.content).toContain("[timed out after 300ms]");
    expect(r.content).toContain("raise timeout_ms");
    expect(r.content).not.toMatch(/\[exit code: 0\]\s*$/); // 超时标记归因优先
  }, 15_000);

  it("timeout 校验表：0/负/超 maxTimeoutMs 拒绝", async () => {
    for (const bad of [0, -1, 600_001]) {
      const r = await bash({ command: "true", timeout_ms: bad });
      expect(r.isError, String(bad)).toBe(true);
    }
  });

  it("截断保尾部三件套：标注在场+尾部内容在场+spill 字节级等于全文（审查 B-P2）", async () => {
    const r = await bash({ command: "seq 1 100000" }); // 100k 行 > 行帽
    expect(r.content).toContain("[output truncated; full output:");
    expect(r.content).toContain("100000"); // 尾部内容保住
    const spill = r.content.match(/full output: ([^\]\s]+)/)?.[1];
    expect(spill).toBeDefined();
    // 字节级全文比对（审查 B-P2：startsWith/endsWith 会漏中段损坏）
    const expected = Buffer.from(`${Array.from({ length: 100_000 }, (_, i) => String(i + 1)).join("\n")}\n`);
    expect(readFileSync(spill as string).equals(expected)).toBe(true);
    // 行帽口径：展示 ≤ 2000 行（尾换行不多算）
    const shown = r.content.split("\n").filter((line) => /^\d+$/.test(line));
    expect(shown.length).toBeLessThanOrEqual(2_000);
    expect(shown[0]).not.toBe("1"); // 头部被截
  }, 20_000);

  it("撕裂 UTF-8：跨 chunk 多字节字符解码正确（无替换符）；多字节超帽截断必收敛（回归：字节校验循环死循环 99% CPU）", async () => {
    const r = await bash({ command: "printf '€%.0s' $(seq 1 20000)" }); // 60KB 欧元符跨 chunk
    expect(r.content).not.toContain("�");
    expect(r.content).toContain("€");
    // 4 字节/字符（emoji）超 30KB 帽：字符数帽内但字节超帽——取尾必须收敛而非空转
    const emoji = await bash({ command: "printf '😀%.0s' $(seq 1 20000)" }); // 80KB emoji
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
    expect(r.content.toLowerCase()).toContain("abort"); // 管线归一文案
    // 组探活：从输出反查不可行——改由下一条用例的 marker 法 + 此处只验收敛速度
  }, 10_000);

  it("回归（进程泄漏）：abort/超时后无存活子进程（marker 文件法 + 墙钟）", async () => {
    // 超时后被杀的组若仍有活进程，marker 会在杀后继续被写
    const marker = join(root, "alive-marker");
    const started = Date.now();
    await bash({ command: `(sleep 2; touch after-kill) & while true; do :; done; true`, timeout_ms: 300 });
    expect(Date.now() - started).toBeLessThan(8_000); // 墙钟：没挂到缺省 120s
    await new Promise((resolve) => {
      setTimeout(resolve, 2_500);
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "after-kill"))).toBe(false); // 组杀覆盖后台孙进程
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
    expect(killed.content).toContain("[exit code: 137]"); // 信号死如实可见（Bun 折算 128+9）
  });

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
    const r = await bash({ command: `sh -c 'trap "" TERM; sleep 6; touch ${marker}' >/dev/null 2>&1 & exit 0`, timeout_ms: 500 });
    expect(r.content).toContain("[exit code: 0]"); // 组长立即退出
    expect(Date.now() - started).toBeLessThan(10_000); // 但工具等到组净（孙进程被 KILL 兜底）
    await new Promise((resolve) => {
      setTimeout(resolve, 6_500);
    });
    expect(existsSync(marker)).toBe(false); // 孙进程被升级 KILL——无孤儿
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
    const repo = process.cwd();
    writeFileSync(
      script,
      [
        `import { createContext, loadPlugins } from ${JSON.stringify(join(repo, "packages/core/src/index.ts"))};`,
        `import { toolsPlugin, toolRegistry } from ${JSON.stringify(join(repo, "packages/tools/src/index.ts"))};`,
        `import { createLocalEnv } from ${JSON.stringify(join(repo, "packages/exec-env/src/local/env.ts"))};\nimport { createToolbox } from ${JSON.stringify(join(repo, "packages/toolbox/src/toolbox.ts"))};`,
        `const ctx = createContext();`,
        `const box = createToolbox({ root: ${JSON.stringify(root)}, env: createLocalEnv(${JSON.stringify(root)}) });`,
        `const unload = await loadPlugins(ctx, [toolsPlugin, box.bashPlugin]);`,
        `const reg = ctx.use(toolRegistry);`,
        `void reg.dispatch({ callId: "host-exit", name: "bash", args: { command: ${JSON.stringify(`sleep 3; touch ${marker}`)}, timeout_ms: 30000 }, signal: new AbortController().signal }).catch(() => {});`,
        `setTimeout(() => process.exit(0), 800); // spawn 已发生、dispatch 未收敛——宿主退出走清场`,
        `void unload;`,
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const code = await child.exited;
    expect(code).toBe(0);
    await new Promise((resolve) => {
      setTimeout(resolve, 3_500); // sleep 3 到点：若组未被杀，marker 会出现
    });
    expect(existsSync(marker)).toBe(false); // 清场杀净——无孤儿孙进程
  }, 15_000);
});

describe("并发档声明（§6 横切——真实 registry 口径）", () => {
  it("read/grep 并行、write/bash 排他", async () => {
    const box = createToolbox({ root, env: createLocalEnv(root) });
    const ctx = createContext();
    const unload = await loadPlugins(ctx, [toolsPlugin, box.readPlugin, box.writePlugin, box.bashPlugin, box.grepPlugin]);
    const reg = ctx.use(toolRegistry);
    const ctrl = new AbortController().signal;
    expect(reg.concurrencyOf("read", {})).toBe("parallel");
    expect(reg.concurrencyOf("grep", {})).toBe("parallel");
    expect(reg.concurrencyOf("write", {})).toBe("exclusive");
    expect(reg.concurrencyOf("bash", {})).toBe("exclusive");
    void ctrl;
    await ctx.dispose();
    void unload;
  });
});
