// 覆盖收口 II（assembly/bash-exec/worker-commands 未达分支）：装配拨号错误面、
// teardownWorld、bash 校验矩阵（脱 worker 上下文的单元级——createBashExec 直调）、
// worker 命令注册表覆盖（全命令名在册断言）。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleWorkerAgent } from "../worker/assembly.ts";
import { createBashExec } from "../worker/bash-exec.ts";
import { createWorkerCommands } from "../worker/worker-commands.ts";
import { createDialogBroker } from "../worker/dialogs.ts";
import { createInflightRegistry, createInflightState } from "../worker/inflight.ts";
import { createEventBridge } from "../worker/event-bridge.ts";
import { COMMAND_NAMES } from "../protocol/commands.ts";
import { OBSERVER_COMMANDS, THREAD_SCOPED_COMMANDS } from "../protocol/internal.ts";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("assembly 装配面", () => {
  test("modelId 未知拒（available 清单）；known dial 直用；teardown 收殓", async () => {
    const agentDir = await tempDir("hub-asm-");
    const sessionsRoot = join(agentDir, "sessions");
    await expect(
      assembleWorkerAgent({ sessionsRoot, trusted: false, modelId: "no-such-model", env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]) } }),
    ).rejects.toThrow("unknown model preset: no-such-model");
    const assembled = await assembleWorkerAgent({
      sessionsRoot,
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]) },
    });
    expect(assembled.dial).toEqual({ provider: "script", model: "script-1" });
    expect(assembled.scriptAdapter).toBeDefined();
    expect(assembled.skillsDirs).toEqual([join(process.env["HOME"] ?? "", ".x-harness", "skills")]);
    await assembled.handle.dispose();
    const world = assembled.world;
    for (const disposer of world.unload) await disposer();
    await world.ctx.dispose(); // teardownWorld 同径（重复 dispose 幂等面不在此断言）
  }, 20_000);

  test("thinking.default 不兼容丢弃（openai 协议拒 thinking——materialize 告警面）", async () => {
    const agentDir = await tempDir("hub-asm2-");
    const sessionsRoot = join(agentDir, "sessions");
    const snapshot = JSON.stringify({
      providers: [{ provider: "o", protocol: "openai", baseUrl: "https://o", apiKey: "k", models: ["m"] }],
      default: { provider: "o", model: "m" },
      modelMeta: {},
    });
    const assembled = await assembleWorkerAgent({
      sessionsRoot,
      trusted: false,
      thinkingDefault: "high",
      env: { HUB_WORKER_PROVIDERS: snapshot },
    });
    expect(assembled.thinking).toBeUndefined(); // 丢弃并告警（stderr）
    expect(assembled.dial).toEqual({ provider: "o", model: "m" });
    await assembled.handle.dispose();
    for (const disposer of assembled.world.unload) await disposer();
    await assembled.world.ctx.dispose();
  }, 20_000);
});

describe("bash-exec 单元（脱 worker 上下文）", () => {
  function makeBash(agentDir: string, confirmResult: boolean) {
    return createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => confirmResult,
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 5_000,
      onStateChange: () => {},
    });
  }

  test("校验矩阵：空命令/坏 timeout/并发无 id/重复 id/满表", async () => {
    const agentDir = await tempDir("hub-bash-");
    const bash = makeBash(agentDir, true);
    expect((await bash.exec({ command: "" })).ok).toBe(false);
    const badTimeout = await bash.exec({ command: "echo x", timeoutMs: 1.5 });
    expect(badTimeout.ok === false && badTimeout.reason).toContain("invalid timeoutMs");
    // 并发无 id：两个在跑（confirm 立即 true + sleep）
    const first = bash.exec({ command: "sleep 1", timeoutMs: 10_000 });
    const second = await bash.exec({ command: "echo y" });
    expect(second.ok === false && second.reason).toBe("concurrent direct bash requires a command id");
    // id 重复
    const dupA = bash.exec({ command: "sleep 1", timeoutMs: 10_000, id: "dup" });
    const dupB = await bash.exec({ command: "echo z", id: "dup" });
    expect(dupB.ok === false && dupB.reason).toBe("bash command id is already in use");
    // 满表（8 槽）
    const slots: Promise<unknown>[] = [first, dupA];
    for (let i = 0; i < 6; i += 1) slots.push(bash.exec({ command: "sleep 1", timeoutMs: 10_000, id: `s-${i}` }));
    const overflow = await bash.exec({ command: "echo w", id: "w" });
    expect(overflow.ok === false && overflow.reason).toBe("too many concurrent direct bash executions (limit reached)");
    // abortRunning 全停 → 槽释放后可再跑
    bash.abortRunning(undefined);
    await Promise.allSettled(slots);
    const after = await bash.exec({ command: "echo ok" });
    expect(after.ok).toBe(true);
  }, 20_000);

  test("确认拒绝 → permission denied；abortRunning 带 id 定向（unknown id 落穿全停）", async () => {
    const agentDir = await tempDir("hub-bash2-");
    const denied = makeBash(agentDir, false);
    const outcome = await denied.exec({ command: "echo no", id: "n1" });
    expect(outcome.ok === false && outcome.reason).toBe("permission denied");
    const bash = makeBash(agentDir, true);
    const running = bash.exec({ command: "sleep 2", timeoutMs: 30_000, id: "target" });
    const other = bash.exec({ command: "sleep 2", timeoutMs: 30_000, id: "other" });
    bash.abortRunning("target"); // 定向
    const targetOutcome = await running;
    expect(targetOutcome.ok === true && targetOutcome.cancelled).toBe(true);
    bash.abortRunning("ghost-id"); // unknown id 落穿 → 全停
    const otherOutcome = await other;
    expect(otherOutcome.ok === true && otherOutcome.cancelled).toBe(true);
  }, 20_000);

  test("shell 解析失败面（坏 HUB_BASH 注入）", async () => {
    const agentDir = await tempDir("hub-bash3-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => true,
      emitEvent: () => {},
      agentDir,
      defaultTimeoutMs: 5_000,
      onStateChange: () => {},
      shell: { ok: false, reason: "bash unavailable on this platform" },
    });
    const outcome = await bash.exec({ command: "echo x" });
    expect(outcome.ok === false && outcome.reason).toBe("bash unavailable on this platform");
  });
});

describe("worker 命令注册表", () => {
  test("全部 THREAD_SCOPED 命令在册（worker 侧注册面完整性——不含 host 本地域）", () => {
    const rt = makeRuntimeStub();
    const handlers = createWorkerCommands(rt);
    for (const name of THREAD_SCOPED_COMMANDS) {
      expect(handlers.has(name), `worker handler missing: ${name}`).toBe(true);
    }
    // host 本地域不在 worker 注册表
    for (const name of ["thread/list", "get_models", "settings/get", "workspace/trust"]) {
      expect(handlers.has(name)).toBe(false);
    }
    // ui_response 特例：在册（弹窗应答路由）
    expect(handlers.has("ui_response")).toBe(true);
    // 观察者命令全部可同步处理器（无重置 idle 副作用在 worker.ts 判定）
    for (const name of OBSERVER_COMMANDS) {
      expect(handlers.has(name)).toBe(true);
    }
    // 命令封闭集与注册表互检（THREAD_SCOPED ∪ ui_response ⊆ 注册表 ⊆ COMMAND_NAMES）
    for (const name of handlers.keys()) {
      expect(COMMAND_NAMES.includes(name), `unregistered command name: ${name}`).toBe(true);
    }
  });

  test("无会话命令全走 Unknown threadId（表驱动）", async () => {
    const rt = makeRuntimeStub();
    const handlers = createWorkerCommands(rt);
    const out: string[] = [];
    rt.emitLine = (line) => out.push(line);
    for (const name of ["get_state", "prompt", "steer", "follow_up", "abort", "clear_queue", "compact", "fork", "clone", "set_model", "bash", "abort_bash", "subagent/steer", "set_thinking_level", "get_thinking_level", "permission/set_mode", "permission/get_mode", "thread/start", "thread/resume"]) {
      const handler = handlers.get(name);
      expect(handler).toBeDefined();
      await handler?.({ id: `q-${name}`, threadId: "ghost" });
    }
    await handlers.get("get_messages")?.({ id: "q2" });
    await handlers.get("get_entries")?.({ id: "q3" });
    // thread/start 无会话不拒（装配路径——真装配在 embedded 旅程覆盖；此处 stub 直拒）
    const responses = out.map((line) => JSON.parse(line) as { error?: string });
    expect(responses.every((frame) => frame.error !== undefined)).toBe(true);
  });
});

function makeRuntimeStub(): Parameters<typeof createWorkerCommands>[0] {
  const captured: string[] = [];
  const broker = createDialogBroker({ confirmTimeoutMs: 50, sendFrame: (line) => void captured.push(line) });
  const bash = createBashExec({
    session: () => undefined,
    cwd: () => "/tmp",
    confirm: async () => false,
    emitEvent: () => {},
    agentDir: "/tmp",
    defaultTimeoutMs: 100,
    onStateChange: () => {},
  });
  return {
    state: {
      handle: undefined,
      world: undefined,
      catalog: { providers: [], default: { provider: "", model: "" }, modelMeta: {} },
      dial: { provider: "script", model: "script-1" },
      thinking: undefined,
      permissionService: undefined,
      delegation: undefined,
      threadId: "",
      sessionPath: "",
      cwd: "/tmp",
      trusted: false,
      compacting: false,
      skillsDirs: [],
      skillsDisabled: new Set(),
      scriptAdapter: undefined,
    },
    emitLine: (line) => void captured.push(line),
    agentDir: "/tmp",
    sessionsRoot: "/tmp",
    broker,
    bash,
    inflight: createInflightRegistry(),
    inflightState: createInflightState(),
    bridge: createEventBridge({ emitLine: () => {}, threadId: () => "", inflight: createInflightState() }),
    triggerShutdown: () => {},
    env: {},
    pendingSends: 0,
  };
}
