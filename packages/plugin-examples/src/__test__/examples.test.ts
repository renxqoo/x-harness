// 13 个真实场景插件验证集（架构自洽走查的实体化）：每个用例 = 一次表面走查。
// 装置 = F1 kits + F3 testkit dogfood（test-world.ts）。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor, createQueryService, sqliteTelemetryPlugin } from "@x-harness/telemetry-sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { Type } from "@sinclair/typebox";
import { textScript } from "@x-harness/testkit";
import { makeTestWorld, runTurn, textsOf, AGENT } from "../test-world.ts";
import { budgetGuardPlugin } from "../budget-guard.ts";
import { destructiveGuardPlugin } from "../destructive-guard.ts";
import { hallucinationFixerPlugin } from "../hallucination-fixer.ts";
import { jsonEnforcerPlugin } from "../json-enforcer.ts";
import { loopBreakerPlugin } from "../loop-breaker.ts";
import { memoryLitePlugin } from "../memory-lite.ts";
import { modelFallbackPlugin } from "../model-fallback.ts";
import { personaOverridePlugin } from "../persona-override.ts";
import { piiScrubberPlugin } from "../pii-scrubber.ts";
import { rateLimiterPlugin } from "../rate-limiter.ts";
import { toolGuideDynamicPlugin } from "../tool-guide-dynamic.ts";
import { webFetchPlugin } from "../web-fetch.ts";
import { perSessionContextPlugin } from "../per-session-context.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "xh-plx-t-"));
  dirs = [...dirs, d];
  return d;
};

describe("① 自定义权限（vetoTools）", () => {
  it("危险 bash/write 模式否决；正常命令放行", async () => {
    const tw = await makeTestWorld([destructiveGuardPlugin()]);
    const reg = tw.world.registry;
    const bad = await reg.dispatch({ callId: "c1", name: "bash", args: { command: "rm -rf /tmp/x" }, signal: new AbortController().signal });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("destructive-guard");
    const good = await reg.dispatch({ callId: "c2", name: "bash", args: { command: "ls" }, signal: new AbortController().signal });
    expect(good.isError).toBeUndefined();
    await tw.cleanup();
  });
});

describe("② 成本上限（tapSessionEvents + cancel）", () => {
  it("用量超限 → turn 被 cancel 中止（aborted 收尾）", async () => {
    const exceeded: string[] = [];
    const tw = await makeTestWorld([budgetGuardPlugin({ maxTotalTokens: 5, onExceeded: (_s, total) => exceeded.push(String(total)) })]);
    tw.scripts.push(
      (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "text-delta", text: "ok" };
        yield { type: "usage", usage: { input: 10, output: 5 } };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript("never"),
    );
    const events = await runTurn(tw, "hi");
    expect(exceeded.length).toBeGreaterThan(0); // 熔断触发
    expect(events.some((e) => e.type === "assistant/message")).toBe(true); // 首条已落账
    await tw.cleanup();
  });
});

describe("③ 幻觉纠正（transformAssistant）", () => {
  it("重复段落折叠 + 标记后缀落账", async () => {
    const tw = await makeTestWorld([hallucinationFixerPlugin()]);
    const para = "The answer is 42. Trust me.";
    tw.scripts.push(textScript(`${para}\n\n${para}\n\n${para}`));
    const events = await runTurn(tw, "q");
    expect(textsOf(events, "assistant/message")[0]).toContain("[repeated paragraphs collapsed");
    expect(textsOf(events, "assistant/message")[0]?.match(/The answer is 42/g)).toHaveLength(1);
    await tw.cleanup();
  });
});

describe("④ 死循环纠正（transformAssistant × transformMessages 组合）", () => {
  it("连续重复 → 截断标记 + 下一轮注入纠偏提醒（闭包跨 turn 保持）", async () => {
    const tw = await makeTestWorld([loopBreakerPlugin({ maxRepeats: 1 })]);
    const spin = "I am still thinking about the problem let me reconsider";
    const made = await tw.world.loop.create({ agent: AGENT });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    for (const reply of [spin, spin, "final answer"]) {
      tw.scripts.push(textScript(reply));
      made.value.agent.followup("go");
      await made.value.agent.whenIdle();
    }
    const events = made.value.agent.session.events();
    const all = textsOf(events, "assistant/message").join("|");
    expect(all).toContain("[loop detected and truncated"); // 第二轮同尾 → 截断
    expect(textsOf(events, "user/message").some((t) => t.includes("repeating yourself"))).toBe(true); // 第三轮注入
    await tw.cleanup();
  });
});

describe("⑤ 工具条件提示词（section 函数形 + registry 懒读）", () => {
  it("有 bash → 围栏纪律行；引导词随工具集变化", async () => {
    const tw = await makeTestWorld([toolGuideDynamicPlugin()]);
    const text = tw.world.prompt.assemble().text;
    expect(text).toContain("Tool Discipline (dynamic)");
    expect(text).toContain("denied domain is a fence");
    await tw.cleanup();
  });
});

describe("⑥ 人格覆盖（同名段覆盖 baseCore）", () => {
  it("自定义 persona 顶替基础段（world prompt 以 persona 开头）", async () => {
    const tw = await makeTestWorld([personaOverridePlugin("You are Seraphina, a meticulous research assistant.")]);
    const text = tw.world.prompt.assemble().text;
    expect(text.startsWith("You are Seraphina")).toBe(true);
    expect(text).not.toContain("You are Agent");
    await tw.cleanup();
  });
});

describe("⑦ 本地遥测（telemetry-sqlite 生产路径——替代旧 audit-log 演示）", () => {
  it("OTel span/log 落 sqlite（含 usage 四字段 + 树形 span 序）", async () => {
    const db = new Database(":memory:");
    const exec = createBunSqliteExecutor(db);
    const tw = await makeTestWorld([
      sqliteTelemetryPlugin({ db: exec, tx: exec.tx, resource: { serviceName: "examples-test" }, includeBodies: true, onIoError: (m) => { throw new Error(m); } }),
    ]);
    tw.scripts.push((async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
      yield { type: "text-delta", text: "audited" };
      yield { type: "usage", usage: { input: 9, output: 3, cacheRead: 1, cacheWrite: 2 } };
      yield { type: "finish", finish: { kind: "stop" } };
    })());
    const events = await runTurn(tw, "audit me");
    const query = createQueryService(exec);
    // 事件流全量落 log 表：从 otel_sessions 提取唯一 session id 再对账
    const sessions = exec.all<{ session_id: string }>("SELECT DISTINCT session_id FROM otel_sessions");
    expect(sessions.length).toBe(1);
    const id = sessions[0]?.["session_id"] ?? "";
    expect(query.logsOf(id).map((row) => row.eventType)).toEqual(events.map((event) => event.type));
    expect(query.usageOf(id)).toEqual({ inputTokens: 9, outputTokens: 3, cacheRead: 1, cacheWrite: 2 }); // usage 四字段透传
    const names = query.spansOf(id).map((row) => row.name);
    expect(names[0]).toBe("session");
    expect(names).toContain("turn");
    expect(names).toContain("step");
    expect(names).toContain("llm.chat");
    await tw.cleanup(); // teardown 终排空完成后再关库（插件不持连接——close 归宿主）
    db.close();
  });
});

describe("⑧ 结构化输出（transformAssistant JSON 修复）", () => {
  it("markdown 围栏剥除 + 压紧 JSON 落账；非 JSON 不碰", async () => {
    const tw = await makeTestWorld([jsonEnforcerPlugin({ validate: (v) => typeof (v as { ok?: unknown }).ok === "boolean" })]);
    tw.scripts.push(textScript('```json\n{ "ok": true, "n": 1 }\n```'));
    const events = await runTurn(tw, "give json");
    expect(textsOf(events, "assistant/message")[0]).toBe('{"ok":true,"n":1}');
    await tw.cleanup();
  });
});

describe("⑨ 模型降级（requestError × request 组合）", () => {
  it("主模型失败 → 重试切备用档（拨号变换可观测）", async () => {
    const tw = await makeTestWorld([modelFallbackPlugin({ primaryModel: "fake-model", fallbackModel: "backup-model" })]);
    tw.scripts.push(
      (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        yield { type: "finish", finish: { kind: "error", message: "upstream 503", code: "http-503" } };
      })(),
      textScript("from-backup"),
    );
    const events = await runTurn(tw, "q");
    expect(textsOf(events, "assistant/message")).toEqual(["from-backup"]);
    expect(tw.calls.some((c) => c.model === "backup-model")).toBe(true); // 拨号变换生效
    await tw.cleanup();
  });
});

describe("⑩ 轻量记忆（tap 持久化 × 注入）", () => {
  it("首轮问答落盘 → 次轮命中关键词注入", async () => {
    const dir = tmp();
    const store = join(dir, "memory.txt");
    const tw = await makeTestWorld([memoryLitePlugin({ store })]);
    const seed = await tw.world.loop.create({ agent: AGENT });
    expect(seed.ok).toBe(true);
    if (seed.ok) {
      tw.scripts.push(textScript("the launch code is alpha-77"));
      seed.value.agent.followup("what is the launch code");
      await seed.value.agent.whenIdle();
      tw.scripts.push(textScript("recalled"));
      seed.value.agent.followup("remind me the launch code");
      await seed.value.agent.whenIdle();
      const users = textsOf(seed.value.agent.session.events(), "user/message");
      expect(users.some((t) => t.includes("Relevant memory") && t.includes("launch code"))).toBe(true); // 注入命中
      expect(readFileSync(store, "utf8")).toContain("alpha-77"); // 持久化在盘
    }
    await tw.cleanup();
  });
});

describe("⑪ 工具限流（vetoTools 滑窗）", () => {
  it("窗口内第三次否决；窗口外放行（惰性清扫）", async () => {
    const ctx = createContext();
    await loadPlugins(ctx, [sessionPlugin, toolsPlugin, rateLimiterPlugin({ maxCallsPerWindow: 2, windowMs: 5 })]);
    const reg = ctx.use(toolRegistry);
    reg.register({ name: "probe", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    const call = (id: string): Promise<{ isError?: true; content: string }> =>
      reg.dispatch({ callId: id, name: "probe", args: {}, signal: new AbortController().signal });
    expect((await call("a")).isError).toBeUndefined();
    expect((await call("b")).isError).toBeUndefined();
    const blocked = await call("c");
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("rate limit");
    await new Promise((r) => { setTimeout(r, 10); }); // 窗口滑过
    expect((await call("d")).isError).toBeUndefined();
    await ctx.dispose();
  });
});

describe("⑫ PII 脱敏（transformAssistant × transformToolResult）", () => {
  it("邮箱/密钥/SSN 打码后落账", async () => {
    const tw = await makeTestWorld([piiScrubberPlugin()]);
    tw.scripts.push(textScript("contact bob@example.com with sk-abc123def456ghi789jkl and 123-45-6789"));
    const events = await runTurn(tw, "q");
    const text = textsOf(events, "assistant/message")[0] ?? "";
    expect(text).toContain("[email]");
    expect(text).toContain("[api-key]");
    expect(text).toContain("[ssn]");
    expect(text).not.toContain("bob@example.com");
    await tw.cleanup();
  });
});

describe("⑬ 新工具插件（createToolPlugin + guidance 投稿 + fetcher 注入）", () => {
  it("fetch 工具注册 + guidance 停靠 + 可换实现", async () => {
    const dir = tmp();
    const tw = await makeTestWorld([webFetchPlugin({ root: dir, fetch: async (url) => ({ status: 200, body: `body-of:${String(url)}` }) })]);
    const reg = tw.world.registry;
    expect(reg.schemas().map((s) => s.name)).toContain("fetch");
    const out = await reg.dispatch({ callId: "f1", name: "fetch", args: { url: "https://example.com/x" }, signal: new AbortController().signal });
    expect(out.content).toContain("body-of:https://example.com/x");
    expect(tw.world.prompt.assemble().text).toContain("## Web Fetch"); // guidance 投稿停靠
    const bad = await reg.dispatch({ callId: "f2", name: "fetch", args: { url: "ftp://x" }, signal: new AbortController().signal });
    expect(bad.isError).toBe(true); // 协议门
    await tw.cleanup();
  });
});

describe("⑭ 每会话动态上下文（sessionCreated → scoped section + 终结清层）", () => {
  it("会话建立即注入专属段；dispose 会话后层清理（assemble 回纯根层）", async () => {
    const tw = await makeTestWorld([perSessionContextPlugin((h) => `Context for session ${String(h.id).slice(0, 8)} cwd=${String(h.cwd ?? "n/a")}`)]);
    const made = await tw.world.loop.create({ agent: { ...AGENT }, session: { id: "sess-14" as never, header: { id: "sess-14" as never, createdAt: Date.now(), cwd: "/w/ctx" } } });
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error(made.reason);
    const sid = made.value.agent.session.id;
    const withLayer = tw.world.prompt.assemble({ sessionId: sid }).text;
    expect(withLayer).toContain("Context for session");
    expect(withLayer).toContain("cwd=/w/ctx");
    expect(tw.world.prompt.assemble().text).not.toContain("Context for session"); // 他会话不受污染
    await made.value.dispose(); // → sessionDisposed → dropLayer
    expect(tw.world.prompt.assemble({ sessionId: sid }).text).not.toContain("Context for session"); // 清层生效
    await tw.cleanup();
  });
});
