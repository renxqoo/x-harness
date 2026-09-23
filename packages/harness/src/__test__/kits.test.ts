// F1 kit 形状 + createAgentWorld（SDK-MIGRATION-F1 §3）：乱序插件集仍正确（软约束生效）、
// 五服务缺席 fail-closed、失败自清理、最小世界端到端跑一轮。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Plugin } from "@x-harness/core";
import { createLocalEnv } from "@x-harness/exec-env";
import { compactionRunner } from "@x-harness/compaction";
import { sessionPlugin } from "@x-harness/session";
import { autoCompactKit, compactionKit } from "../index.ts";
import { PathGate } from "@x-harness/tool-core";
import { textScript } from "@x-harness/testkit";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { Database } from "bun:sqlite";
import { createAgentWorld, inlineSessionKit, llmKit, loopKit, meterKit, promptKit, telemetryKit, telemetryKitWithHandle, toolboxKit } from "../index.ts";
import { createBunSqliteExecutor } from "@x-harness/telemetry-sqlite";

let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

const AGENT = { model: "m", provider: "fake" };

describe("createAgentWorld + kits（F1）", () => {
  it("最小世界端到端：乱序数组（meter 在 prompt 前、toolbox 在 systemPrompt 前）仍正确装配并跑一轮", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-"));
    const gate = new PathGate(root);
    const env = createLocalEnv(root);
    const plugins: readonly Plugin[] = [
      ...meterKit(),
      ...toolboxKit({ root, gate, env }), // 数组序在 promptKit 之前——softInject 拉正
      ...inlineSessionKit(),
      ...llmKit([{ name: "fake", stream: () => textScript("kit-hello") }]),
      ...promptKit(),
      ...loopKit(),
    ];
    const world = await createAgentWorld({ plugins });
    expect(world.ok).toBe(true);
    if (!world.ok) throw new Error(world.reason);
    const made = await world.value.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    const joined = (event: { data: unknown }): string =>
      ((event.data as { content?: readonly { type: string; text?: string }[] }).content ?? []).map((b) => (b as { text?: string }).text ?? "").join("");
    const texts = made.value.agent.session.events().filter((e) => e.type === "assistant/message").map(joined);
    expect(texts).toEqual(["kit-hello"]);
    expect(world.value.registry.schemas().map((s) => s.name)).toContain("bash"); // toolbox 装齐
    await world.value.ctx.dispose();
  });

  it("五服务缺席 → fail-closed（ok:false + 自清理）", async () => {
    const result = await createAgentWorld({ plugins: [systemPromptPlugin] }); // 无 session/loop/tools/meter
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not provided/);
  });

  it("坏插件 throw → 自清理（dispose 后无悬挂）", async () => {
    const bad: Plugin = { name: "bad", apply: () => { throw new Error("boom"); } };
    const result = await createAgentWorld({ plugins: [bad, ...inlineSessionKit()] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("boom");
  });

  it("toolboxKit 缺省接线：gate/observed 内包（read/write 共享实例）", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-2"));
    const plugins: readonly Plugin[] = [
      ...inlineSessionKit(),
      ...toolboxKit({ root, env: createLocalEnv(root) }),
    ];
    const ctx = createContext();
    const unload = await loadPlugins(ctx, plugins);
    expect(ctx.use((await import("@x-harness/tools")).toolRegistry).schemas().map((s) => s.name)).toEqual(["read", "write", "bash", "grep", "task_stop"]);
    for (const dispose of unload) await dispose();
    await ctx.dispose();
  });

  it("toolboxKit taskLogDir 透传：bash 后台日志落在传入根下", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-3"));
    const logRoot = mkdtempSync(join(tmpdir(), "xh-kits-logs-"));
    try {
      const plugins: readonly Plugin[] = [
        ...inlineSessionKit(),
        ...toolboxKit({ root, env: createLocalEnv(root), taskLogDir: logRoot }),
      ];
      const ctx = createContext();
      const unload = await loadPlugins(ctx, plugins);
      const reg = ctx.use((await import("@x-harness/tools")).toolRegistry);
      const r = await reg.dispatch({ callId: "k1", name: "bash", args: { command: "echo kit-log", run_in_background: true }, signal: new AbortController().signal, session: "s-kit" as never });
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain(logRoot); // 日志路径在传入根下（透传链 bash taskLimits ✓）
      const logPath = (r.content.match(/output appends to ([^;]+);/) ?? ["", ""])[1] ?? "";
      const { backgroundTasks } = await import("@x-harness/tool-bash");
      const tasks = ctx.use(backgroundTasks);
      const deadline = Date.now() + 5_000;
      while ((tasks.list("s-kit" as never)[0]?.endedAt) === undefined && Date.now() < deadline) {
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      const allowed = await reg.dispatch({ callId: "k2", name: "read", args: { path: logPath }, signal: new AbortController().signal, session: "s-kit" as never });
      expect(allowed.isError).toBeUndefined(); // read 经 systemRoots 放行（透传链 read ✓）
      expect(allowed.content).toContain("kit-log");
      for (const dispose of unload) await dispose();
      await ctx.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(logRoot, { recursive: true, force: true });
    }
  });
});

describe("telemetryKit（本地遥测接入 F1 kit 目录）", () => {
  it("执行面形态：内存库跑一轮 → world.telemetry 可查 span 树 + log 流 + usage", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-tel-"));
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    const plugins: readonly Plugin[] = [
      ...meterKit(),
      ...toolboxKit({ root, gate: new PathGate(root), env: createLocalEnv(root) }),
      ...inlineSessionKit(),
      ...telemetryKit({ db: exec, tx: exec.tx, resource: { serviceName: "kits-test" } }),
      ...llmKit([{ name: "fake", stream: () => (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "text-delta", text: "measured" };
        yield { type: "usage", usage: { input: 8, output: 4, cacheRead: 1, cacheWrite: 1 } };
        yield { type: "finish", finish: { kind: "stop" } };
      })() }]),
      ...promptKit(),
      ...loopKit(),
    ];
    const world = await createAgentWorld({ plugins });
    expect(world.ok).toBe(true);
    if (!world.ok) throw new Error(world.reason);
    expect(world.value.telemetry).toBeDefined(); // 可选服务面：kit 在场即暴露
    const made = await world.value.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    await world.value.ctx.dispose();
    const telemetry = world.value.telemetry;
    if (telemetry === undefined) throw new Error("telemetry missing");
    const sessions = exec.all<{ session_id: string }>("SELECT DISTINCT session_id FROM otel_sessions");
    expect(sessions.length).toBe(1);
    const id = sessions[0]?.["session_id"] ?? "";
    const names = telemetry.spansOf(id).map((row) => row.name);
    expect(names[0]).toBe("session");
    expect(names).toContain("turn");
    expect(names).toContain("llm.chat");
    expect(telemetry.usageOf(id)).toEqual({ inputTokens: 8, outputTokens: 4, cacheRead: 1, cacheWrite: 1 });
    expect(telemetry.logsOf(id).length).toBeGreaterThan(3);
    db.close(); // 宿主自持连接：close 归宿主
  });

  it("路径形态：kit 开库 + 连接收殓（dispose 后库文件完整、句柄 close 幂等路径）", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-tel2-"));
    const dbPath = join(root, "telemetry.db");
    const handle = telemetryKitWithHandle({ db: dbPath, resource: { serviceName: "path-test" } });
    const plugins: readonly Plugin[] = [
      ...meterKit(),
      ...toolboxKit({ root, gate: new PathGate(root), env: createLocalEnv(root) }),
      ...inlineSessionKit(),
      ...handle.plugins,
      ...llmKit([{ name: "fake", stream: () => textScript("path-hello") }]),
      ...promptKit(),
      ...loopKit(),
    ];
    const world = await createAgentWorld({ plugins });
    expect(world.ok).toBe(true);
    if (!world.ok) throw new Error(world.reason);
    const made = await world.value.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    made.value.agent.followup("hi");
    await made.value.agent.whenIdle();
    // dispose 前查询（dispose 后连接已收殓——查询面归库文件重开）
    const telemetry = world.value.telemetry;
    expect(telemetry?.logsOf(made.value.agent.session.id).length ?? 0).toBeGreaterThan(3);
    await world.value.ctx.dispose(); // wrapper 组合 teardown：telemetry 终排空 → connection close
    // 重开验证文件库完整性（WAL checkpoint/恢复面）
    const reopen = new Database(dbPath);
    const rows = reopen.query("SELECT COUNT(*) AS n FROM otel_logs").get() as { n: number };
    expect(rows.n).toBeGreaterThan(3);
    reopen.close();
  });

  it("缺席形态：不挂 telemetryKit → world.telemetry === undefined（可选件同 archive）", async () => {
    root = mkdtempSync(join(tmpdir(), "xh-kits-tel3-"));
    const world = await createAgentWorld({
      plugins: [
        ...meterKit(),
        ...toolboxKit({ root, gate: new PathGate(root), env: createLocalEnv(root) }),
        ...inlineSessionKit(),
        ...llmKit([{ name: "fake", stream: () => textScript("bare") }]),
        ...promptKit(),
        ...loopKit(),
      ],
    });
    expect(world.ok).toBe(true);
    if (!world.ok) throw new Error(world.reason);
    expect(world.value.telemetry).toBeUndefined();
    await world.value.ctx.dispose();
  });
});

describe("compactionKit（/compact 插件接入）", () => {
  it("装配后 compactionRunner 可用;summarizer 缺席 = 软禁用手动面", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, ...compactionKit({ contextWindow: 200_000 })]);
    const runner = ctx.use(compactionRunner);
    expect(runner.summarizer).toBeUndefined(); // 未配 summarizer → 手动 compact 报 summarizer-unconfigured
    const result = await runner.compact({ session: "ghost" as never });
    expect(result).toEqual({ ok: false, reason: "session-unknown" });
    await ctx.dispose();
  });
});

describe("autoCompactKit（分层自动压缩接入）", () => {
  it("装配后与 compaction 共存:agentPreStep 分层防线挂上(L1/L2 观测面在场)、CP 面缺省取 runner.summarizer", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, ...compactionKit({ contextWindow: 200_000, summarizer: { model: "sum", provider: "p" } }), ...autoCompactKit({ contextWindow: 200_000 })]);
    const { autocompactL1Cleared } = await import("@x-harness/autocompact");
    const landed: string[] = [];
    ctx.on(autocompactL1Cleared, (payload: unknown) => landed.push(String((payload as { session: string }).session)));
    expect(ctx.use(compactionRunner).summarizer?.model).toBe("sum"); // CP 面单一真相源在场(runner.summarizer)
    await ctx.dispose();
  });
});
