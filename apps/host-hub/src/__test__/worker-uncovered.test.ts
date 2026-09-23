// 覆盖收口 II（assembly/bash-exec/worker-commands 未达分支）：装配拨号错误面、
// teardownWorld、bash 校验矩阵（脱 worker 上下文的单元级——createBashExec 直调）、
// worker 命令注册表覆盖（全命令名在册断言）。
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "@x-harness/system-prompt";
import { assembleWorkerAgent, contextWindowOf } from "../worker/assembly.ts";
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

describe("assembly 窗口解析（模型级 > 档案级 > 兜底——compaction/analytics 共源）", () => {
  test("modelMeta 模型级胜档案级；档案级胜 128k 兜底", () => {
    const catalog = {
      providers: [{ provider: "glm", protocol: "anthropic", baseUrl: "https://x", apiKey: "k", models: ["glm-5.3", "glm-air"], contextWindow: 1_000_000 }],
      default: { provider: "glm", model: "glm-5.3" },
      modelMeta: { "glm-air": { contextWindow: 128_000 } },
    };
    expect(contextWindowOf(catalog as never, { provider: "glm", model: "glm-5.3" })).toBe(1_000_000); // 档案级
    expect(contextWindowOf(catalog as never, { provider: "glm", model: "glm-air" })).toBe(128_000); // 模型级
    expect(contextWindowOf({ providers: [], default: { provider: "", model: "" }, modelMeta: {} } as never, { provider: "x", model: "y" })).toBe(128_000); // 兜底
  });
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

  test("base 系统提示词装配：身份段 + facts 插值（{{}} 无残留）——与 CLI 同源", async () => {
    const agentDir = await tempDir("hub-baseprompt-");
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(agentDir, "sessions"),
      cwd: agentDir,
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: { HUB_WORKER_PROVIDER: "script", HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]) },
    });
    const text = assembled.world.ctx.use(systemPrompt).assemble().text;
    expect(text.indexOf("You are Agent")).toBe(0);
    expect(text).toContain(`- Working directory: ${agentDir}`);
    expect(text).toContain("- Is a git repository: no"); // 临时目录非 git 工作区
    expect(text).toContain(`- Platform: ${process.platform}`);
    expect(text).toContain("- Shell: unknown"); // 测试 env 无 SHELL——垃圾降级不空值
    expect(text).not.toContain("{{");
    await assembled.handle.dispose();
    const world = assembled.world;
    for (const disposer of world.unload) await disposer();
    await world.ctx.dispose();
  }, 20_000);

  test("thinking.default openai 渠道保留（协议无条件拒已撤——仅目录 reasoning:false 拒）", async () => {
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
    // 5d6bd1e 撤「openai 协议无条件拒 thinking」（capability_thinking 误拒根治）：
    // openai 渠道的 thinking 缺省现在原样保留，仅目录 reasoning:false 才拒
    expect(assembled.thinking).toBe("high");
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
    commands: undefined,
      threadId: "",
      sessionPath: "",
      cwd: "/tmp",
      trusted: false,
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


describe("queue/drop、queue/send_now 单条分支（stub 直调——streaming_window 防御面）", () => {
  /** 带一条 next-turn 排队条目的最小会话 stub（foldInbox 投影所需的最小事件面）。 */
  function makeQueuedSession() {
    const appends: Array<{ type: string; data: unknown }> = [];
    const insert = {
      type: "agent/inbox/spliced",
      seq: 1,
      time: 1,
      data: { op: "insert", target: "next-turn", entries: [{ id: "f1", content: [{ type: "text", text: "q" }] }] },
    };
    const session = {
      id: "t1",
      events: () => [insert],
      append: (type: string, data: unknown) => {
        appends.push({ type, data });
        return { ok: true as const };
      },
    };
    return { session, appends };
  }

  function stubWithSession(pendingSends: number) {
    const rt = makeRuntimeStub();
    const { session, appends } = makeQueuedSession();
    rt.state.threadId = "t1";
    rt.state.handle = { agent: { session } } as never;
    rt.pendingSends = pendingSends;
    const out: string[] = [];
    rt.emitLine = (line) => out.push(line);
    return { rt, appends, out };
  }

  test("空闲且无在飞 send（streaming_window）：拒绝且不落任何 WAL 事件（防御分支直测）", async () => {
    const { rt, appends, out } = stubWithSession(0);
    const handlers = createWorkerCommands(rt);
    await handlers.get("queue/send_now")?.({ id: "r1", threadId: "t1", entryId: "f1" });
    const frame = JSON.parse(out[0] ?? "{}") as { success?: boolean; error?: { code?: string } };
    expect(frame.success).toBe(false);
    expect(frame.error?.code).toBe("streaming_window");
    expect(appends).toEqual([]); // 拒绝路径不写收件箱（条目留在队列）
  });

  test("在飞 send 覆盖窗口（pendingSends>0）：retarget 落 WAL 且 entry 原样跨队列", async () => {
    const { rt, appends, out } = stubWithSession(1);
    const handlers = createWorkerCommands(rt);
    await handlers.get("queue/send_now")?.({ id: "r2", threadId: "t1", entryId: "f1" });
    const frame = JSON.parse(out[0] ?? "{}") as { success?: boolean };
    expect(frame.success).toBe(true);
    expect(appends).toEqual([{ type: "agent/inbox/spliced", data: { op: "retarget", id: "f1", to: "next-step" } }]);
  });

  test("queue/drop 空闲可删（无轮次要求）：drop 落 WAL", async () => {
    const { rt, appends, out } = stubWithSession(0);
    const handlers = createWorkerCommands(rt);
    await handlers.get("queue/drop")?.({ id: "r3", threadId: "t1", entryId: "f1" });
    const frame = JSON.parse(out[0] ?? "{}") as { success?: boolean };
    expect(frame.success).toBe(true);
    expect(appends).toEqual([{ type: "agent/inbox/spliced", data: { op: "drop", target: "next-turn", dropped: ["f1"], reason: "client-drop" } }]);
  });
});
