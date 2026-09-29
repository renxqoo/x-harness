import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "@x-harness/system-prompt";
import { readHubSettings } from "../shared/settings-store.ts";
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

const scriptEnv = async (): Promise<Record<string, string>> => ({
  HUB_WORKER_PROVIDER: "script",
  HUB_WORKER_SCRIPT: JSON.stringify([{ reply: "x" }]),
  X_HARNESS_MAILBOX_DIR: join(await tempDir("hub-mb-"), "mailbox"),
  X_HARNESS_WORKFLOW_DIR: join(await tempDir("hub-wf-"), "workflows"),
});

describe("assembly 窗口解析（模型级 > 档案级 > 兜底——compaction/analytics 共源）", () => {
  test("modelMeta 模型级胜档案级；都未配则 undefined（不再套 128k 假分母）", () => {
    const catalog = {
      providers: [{ provider: "glm", protocol: "anthropic", baseUrl: "https://x", apiKey: "k", models: ["glm-5.3", "glm-air"], contextWindow: 1_000_000 }],
      default: { provider: "glm", model: "glm-5.3" },
      modelMeta: { "glm\u0000glm-air": { contextWindow: 128_000 } },
    };
    expect(contextWindowOf(catalog as never, { provider: "glm", model: "glm-5.3" })).toBe(1_000_000);
    expect(contextWindowOf(catalog as never, { provider: "glm", model: "glm-air" })).toBe(128_000);
    // 未配窗口 → undefined（症状回归：曾静默套 128k，让压缩阈值与百分比都建在假分母上）
    expect(contextWindowOf({ providers: [], default: { provider: "", model: "" }, modelMeta: {} } as never, { provider: "x", model: "y" })).toBeUndefined();
  });

  test("症状回归：跨渠道同名模型不互相覆盖窗口（modelMeta 单键表曾让 GLM 的 1M 被无窗口渠道抹掉）", () => {
    // 真实形态：GLM 与 GML2 都有 glm-5.3-flash；GML2 未配窗口。
    // 单键表下 modelMeta["glm-5.3-flash"] 被后写的 GML2 覆盖成 {}，
    // 解析落到 128k 兜底——用户配的 1M 被吃掉（实测 WAL 落 128000）。
    const catalog = {
      providers: [
        { provider: "GLM", protocol: "anthropic", baseUrl: "https://glm", apiKey: "k", models: ["glm-5.3-flash"] },
        { provider: "GML2", protocol: "anthropic", baseUrl: "https://glm2", apiKey: "k", models: ["glm-5.3-flash"] },
      ],
      default: { provider: "GLM", model: "glm-5.3-flash" },
      modelMeta: {
        "GLM\u0000glm-5.3-flash": { contextWindow: 1_000_000, reasoning: true },
        "GML2\u0000glm-5.3-flash": { reasoning: true },
      },
    };
    // 同名模型各按自己的渠道解析——GLM 必须拿到配的 1M，不被 GML2 抹掉
    expect(contextWindowOf(catalog as never, { provider: "GLM", model: "glm-5.3-flash" })).toBe(1_000_000);
    // GML2 未配 → undefined（不再套假值）
    expect(contextWindowOf(catalog as never, { provider: "GML2", model: "glm-5.3-flash" })).toBeUndefined();
  });
});

describe("assembly 装配面", () => {
  test("modelId 未知拒（available 清单）；known dial 直用；teardown 收殓", async () => {
    const agentDir = await tempDir("hub-asm-");
    const sessionsRoot = join(agentDir, "sessions");
    await expect(
      assembleWorkerAgent({ sessionsRoot, trusted: false, modelId: "no-such-model", env: await scriptEnv() }),
    ).rejects.toThrow("unknown model preset: no-such-model");
    const assembled = await assembleWorkerAgent({
      sessionsRoot,
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: await scriptEnv(),
    });
    expect(assembled.dial).toEqual({ provider: "script", model: "script-1" });
    expect(assembled.scriptAdapter).toBeDefined();
    expect(assembled.skillsDirs).toEqual([join(process.env["HOME"] ?? "", ".x-harness", "skills")]);
    await assembled.handle.dispose();
    const world = assembled.world;
    for (const disposer of world.unload) await disposer();
    await world.ctx.dispose();
  }, 20_000);

  test("base 系统提示词装配：身份段 + facts 插值（{{}} 无残留）——与 CLI 同源", async () => {
    const agentDir = await tempDir("hub-baseprompt-");
    const assembled = await assembleWorkerAgent({
      sessionsRoot: join(agentDir, "sessions"),
      cwd: agentDir,
      trusted: false,
      dial: { provider: "script", model: "script-1" },
      env: await scriptEnv(),
    });
    const text = assembled.world.ctx.use(systemPrompt).assemble().text;
    expect(text.indexOf("You are xh")).toBe(0);
    expect(text).toContain(`- Working directory: ${agentDir}`);
    expect(text).toContain("- Is a git repository: no");
    expect(text).toContain(`- Platform: ${process.platform}`);
    expect(text).toContain("- Shell: unknown");
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
      confirm: async () => ({ allowed: confirmResult }),
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
    const first = bash.exec({ command: "sleep 1", timeoutMs: 10_000 });
    const second = await bash.exec({ command: "echo y" });
    expect(second.ok === false && second.reason).toBe("concurrent direct bash requires a command id");
    const dupA = bash.exec({ command: "sleep 1", timeoutMs: 10_000, id: "dup" });
    const dupB = await bash.exec({ command: "echo z", id: "dup" });
    expect(dupB.ok === false && dupB.reason).toBe("bash command id is already in use");
    const slots: Promise<unknown>[] = [first, dupA];
    for (let i = 0; i < 6; i += 1) slots.push(bash.exec({ command: "sleep 1", timeoutMs: 10_000, id: `s-${i}` }));
    const overflow = await bash.exec({ command: "echo w", id: "w" });
    expect(overflow.ok === false && overflow.reason).toBe("too many concurrent direct bash executions (limit reached)");
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
    bash.abortRunning("target");
    const targetOutcome = await running;
    expect(targetOutcome.ok === true && targetOutcome.cancelled).toBe(true);
    bash.abortRunning("ghost-id");
    const otherOutcome = await other;
    expect(otherOutcome.ok === true && otherOutcome.cancelled).toBe(true);
  }, 20_000);

  test("习得持久面（U13）：非 trusted 拒 project 写；user 写落盘去重（grantStore 插件）", async () => {
    const agentDir = await tempDir("hub-grantstore-");
    const sessionsRoot = join(agentDir, "sessions");
    const scriptEnvOfFields = await scriptEnv();
    const fields = (trusted: boolean, cwd: string) => ({
      sessionsRoot,
      cwd,
      agentDir,
      trusted,
      dial: { provider: "script", model: "script-1" },
      env: scriptEnvOfFields,
    });
    const untrusted = await assembleWorkerAgent(fields(false, agentDir));
    const storeU = untrusted.world.ctx.tryUse(await import("@x-harness/permission").then((m) => m.permissionGrantStore));
    expect(storeU).toBeDefined();
    if (storeU !== undefined) {
      const rejected = await storeU.write("project", { tool: "Danger", pattern: "x:*", verdict: "allow", nature: "grant" });
      expect(rejected.ok).toBe(false);
      const userWrite = await storeU.write("user", { tool: "Danger", pattern: "u:*", verdict: "allow", nature: "grant", at: 1 });
      expect(userWrite.ok).toBe(true);
      const dup = await storeU.write("user", { tool: "Danger", pattern: "u:*", verdict: "allow", nature: "grant", at: 2 });
      expect(dup.ok).toBe(true);
      const settings = await readHubSettings(agentDir);
      expect(settings["permission.rules"]).toEqual([{ tool: "Danger", pattern: "u:*", verdict: "allow", nature: "grant", at: 1 }]);
    }
    await untrusted.handle.dispose();
    for (const disposer of untrusted.world.unload) await disposer();
    await untrusted.world.ctx.dispose();
  }, 20_000);

  test("shell 解析失败面（坏 HUB_BASH 注入）", async () => {
    const agentDir = await tempDir("hub-bash3-");
    const bash = createBashExec({
      session: () => undefined,
      cwd: () => agentDir,
      confirm: async () => ({ allowed: true }),
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
    for (const name of ["thread/list", "get_models", "settings/get", "workspace/trust"]) {
      expect(handlers.has(name)).toBe(false);
    }
    expect(handlers.has("ui_response")).toBe(true);
    for (const name of OBSERVER_COMMANDS) {
      expect(handlers.has(name)).toBe(true);
    }
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
    confirm: async () => ({ allowed: false }),
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
    bridge: createEventBridge({ emitLine: () => {}, threadId: () => "", inflight: createInflightState(), pendingSends: () => 0, mainEvents: () => undefined }),
    triggerShutdown: () => {},
    env: {},
    pendingSends: 0,
  };
}


describe("queue/drop、queue/send_now 单条分支（stub 直调——streaming_window 防御面）", () => {
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
    expect(appends).toEqual([]);
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
