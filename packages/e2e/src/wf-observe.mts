// 真实任务观测（件 16 workflow 评估）：一条真实链路 + 全程 token/span/时长观测。
// 用法：bun packages/e2e/src/wf-observe.mts [--tier a|b|c|all]
// 观测面：① 每会话 token 用量（input/output/cache——llm span 聚合）② span 时间线（工具调用
// 时长/llm attempt 数）③ workflow journal 事件流（回炉次数/验收轮次）④ 与直通对照的成本差。

import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SessionId } from "@x-harness/session";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime } from "@x-harness/llm";
import type { LlmChunk, LlmRequest } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin } from "@x-harness/agent-delegation";
import { createAgentWorkflowPlugin } from "@x-harness/agent-workflow";
import { createBunSqliteExecutor, sqliteTelemetry, sqliteTelemetryPlugin } from "@x-harness/telemetry-sqlite";
import type { TelemetryQueryService } from "@x-harness/telemetry-sqlite";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(() => {
    resolve();
  }, ms);
});

// ————————————————— 观测报告 —————————————————

interface SessionReport {
  readonly session: string;
  readonly role: string;
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly spans: readonly { readonly name: string; readonly ms: number }[];
}

interface RunReport {
  readonly tier: string;
  readonly wallMs: number;
  readonly sessions: readonly SessionReport[];
  readonly journalEvents: readonly string[];
  readonly notifications: string;
  readonly tokensTotal: number;
}

function fmtUsage(u: SessionReport["usage"]): string {
  return u === undefined ? "无 llm span" : `in ${String(u.input)} / out ${String(u.output)} / cacheR ${String(u.cacheRead)} / cacheW ${String(u.cacheWrite)}（计费当量 ≈ ${String(u.input + u.output * 4 + u.cacheWrite * 2)}）`;
}

function printReport(r: RunReport): void {
  console.log(`\n════════ ${r.tier} ════════`);
  console.log(`wall-clock: ${(r.wallMs / 1000).toFixed(1)}s`);
  for (const s of r.sessions) {
    console.log(`  [${s.role}] ${s.session}`);
    console.log(`    tokens: ${fmtUsage(s.usage)}`);
    if (s.spans.length > 0) {
      const byName = new Map<string, { count: number; totalMs: number }>();
      for (const sp of s.spans) {
        const e = byName.get(sp.name) ?? { count: 0, totalMs: 0 };
        e.count += 1;
        e.totalMs += sp.ms;
        byName.set(sp.name, e);
      }
      for (const [name, e] of byName) console.log(`    span ${name} ×${String(e.count)} ${(e.totalMs / 1000).toFixed(1)}s`);
    }
  }
  console.log(`  journal: ${r.journalEvents.join(" → ")}`);
  console.log(`  tokens 总计（四字段和）: ${String(r.tokensTotal)}`);
  const notif = r.notifications.split("\n").filter((l) => l !== "").slice(0, 6);
  console.log(`  通知:\n${notif.map((l) => `    | ${l}`).join("\n")}`);
}

// ————————————————— 装置 —————————————————

interface ObserveWorld {
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly scripts: Map<string, Array<{ text: string; delayMs?: number }>>;
  readonly telemetry: TelemetryQueryService;
  readonly db: Database;
  readonly root: string;
  readonly submit: (input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  readonly texts: () => string;
  readonly dispose: () => Promise<void>;
}

async function assembleObserve(root: string, options: { readonly agentsDir?: string; readonly sandbox?: boolean; readonly deadlineMs?: number } = {}): Promise<ObserveWorld> {
  const db = new Database(join(root, "telemetry.db"));
  const scripts = new Map<string, Array<{ text: string; delayMs?: number }>>();
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    ...(options.sandbox === true ? [(await import("@x-harness/permission")).createPermissionPlugin({ root, mode: "full" as const }), (await import("@x-harness/sandbox")).createSandboxPlugin({ root })] : []),
    sqliteTelemetryPlugin({ db: createBunSqliteExecutor(db), resource: { serviceName: "wf-observe" } }),
    createAgentDelegationPlugin({ agentsDirs: options.agentsDir !== undefined ? [options.agentsDir] : [], workspaceRoot: root, worktreeSweep: false }),
    createAgentWorkflowPlugin({ root: join(root, "workflows"), mainSession: "obs-parent" as SessionId, ...(options.deadlineMs !== undefined ? { taskDeadlineMs: options.deadlineMs } : {}) }),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const telemetry = ctx.use(sqliteTelemetry);
  ctx.use(llmRuntime).registerAdapter({
    name: "fake",
    stream: (request: LlmRequest) => {
      const next = scripts.get(request.model)?.shift();
      const gen = (async function* (): AsyncGenerator<LlmChunk> {
        if (next?.delayMs !== undefined) await sleep(next.delayMs);
        const text = next?.text ?? "";
        // 分 chunk 产出（模拟真实流——telemetry 的 attempt 级 span 才有形态）
        for (let i = 0; i < Math.max(1, Math.ceil(text.length / 64)); i++) {
          yield { type: "text-delta", text: text.slice(i * 64, (i + 1) * 64) } as never;
        }
        // usage 帧（真实后端在 finish 前上报——token 观测数据源；input 随 prompt 长度、
        // output 随生成长度模拟，量级贴近真实回炉场景）
        const promptChars = JSON.stringify(request).length;
        yield { type: "usage", usage: { input: 400 + promptChars, output: 40 + text.length, cacheRead: 0, cacheWrite: 0 } } as never;
        yield { type: "finish", finish: { kind: "stop" } } as never;
      })();
      return gen;
    },
  });
  const parent = await loop.create({ session: { id: "obs-parent" as SessionId }, agent: { model: "obs-model", provider: "fake" } });
  if (!parent.ok) throw new Error(parent.reason);
  const registry = ctx.use(toolRegistry);
  return {
    ctx,
    loop,
    scripts,
    telemetry,
    db,
    root,
    submit: async (input) => {
      const made = await registry.dispatch({ callId: `obs-${String(Math.random()).slice(2, 8)}`, name: "workflow_submit", args: input, signal: new AbortController().signal, session: "obs-parent" as SessionId });
      return { ok: made.isError !== true, text: String(made.content) };
    },
    texts: () => ctx.use(sessionStore).get("obs-parent" as SessionId)?.events()
      .filter((e) => e.type === "user/message" || (e as { type?: string }).type === "agent/message")
      .map((e) => JSON.stringify(e.data)).join("\n") ?? "",
    dispose: async () => {
      await parent.value.dispose();
      await ctx.dispose();
      db.close();
    },
  };
}

/** 会话观测采集：父 + 全部子会话（store 内非 parent 的会话——工具 spawned） */
async function collectSessions(w: ObserveWorld, roles: Readonly<Record<string, string>>): Promise<readonly SessionReport[]> {
  const reports: SessionReport[] = [];
  const store = w.ctx.use(sessionStore);
  for (const [sessionId, role] of Object.entries(roles)) {
    const usage = w.telemetry.usageOf(sessionId as SessionId);
    // span 时长：跳过未闭合行（endMs null——拆卸路径未闭合折算为负）与 session 级（开闭跨拆卸）
    const spans = w.telemetry.spansOf(sessionId as SessionId)
      .filter((sp) => sp.endMs !== null && sp.name !== "session")
      .map((sp) => ({ name: sp.name, ms: Number(sp.endMs) - Number(sp.startMs) }));
    reports.push({ session: sessionId, role, usage: usage === undefined ? undefined : { input: Number(usage.inputTokens), output: Number(usage.outputTokens), cacheRead: Number(usage.cacheRead), cacheWrite: Number(usage.cacheWrite) }, spans });
  }
  void store;
  return reports;
}

async function journalEventsOf(root: string): Promise<readonly string[]> {
  const types: string[] = [];
  for (const rid of await readdir(join(root, "workflows")).catch(() => [] as string[])) {
    const raw = await readFile(join(root, "workflows", rid, "journal.jsonl"), "utf8").catch(() => "");
    for (const line of raw.split("\n").filter((l) => l !== "")) {
      try {
        types.push((JSON.parse(line) as { type: string; outcome?: string }).type + (((JSON.parse(line) as { outcome?: string }).outcome) !== undefined ? `:${String((JSON.parse(line) as { outcome?: string }).outcome)}` : ""));
      } catch {
        types.push("?");
      }
    }
  }
  return types;
}

// ————————————————— 真实任务旅程 —————————————————

async function observeTierA(): Promise<RunReport> {
  const root = await mkdtemp(join(tmpdir(), "wf-obs-a-"));
  const w = await assembleObserve(root);
  const t0 = Date.now();
  // 真实任务：提取结构化数据（Tier A 旗舰场景）——首轮缺字段触发回炉（观测回炉成本）
  w.scripts.set("obs-model", [
    { text: "I found the data. Title: Migration Report", delayMs: 120 }, // 首轮：自然语言（无 JSON——回炉）
    { text: '{"title": "Migration Report", "sections": ["overview", "steps"], "risk": "low"}', delayMs: 120 }, // 修复轮：合格 JSON
  ]);
  const sent = await w.submit({ description: "extract migration report", prompt: "Read the migration notes and produce the structured report", result_schema: { type: "object", required: ["title", "sections"], properties: { title: { type: "string" }, sections: { type: "array", items: { type: "string" } }, risk: { type: "string" } } } });
  if (!sent.ok) throw new Error(sent.text);
  let childSession = "";
  for (const sid of await readdir(join(root, "workflows")).catch(() => [] as string[])) {
    const raw = await readFile(join(root, "workflows", sid, "journal.jsonl"), "utf8").catch(() => "");
    const m = /"sessionId":"([^"]+)"/.exec(raw);
    if (m?.[1] !== undefined) childSession = m[1];
  }
  await sleep(600);
  const sessions = await collectSessions(w, { "obs-parent": "父代理", ...(childSession !== "" ? { [childSession]: "任务子代理" } : {}) });
  const events = await journalEventsOf(root);
  const texts = w.texts();
  const notifMatch = /\[workflow-notification\][^"\\]*/.exec(texts);
  const tokensTotal = sessions.reduce((acc, s) => acc + (s.usage !== undefined ? s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite : 0), 0);
  const report: RunReport = { tier: "Tier A（schema 抽取——含一次回炉）", wallMs: Date.now() - t0, sessions, journalEvents: events, notifications: notifMatch?.[0] ?? "（未到）", tokensTotal };
  printReport(report);
  await w.dispose();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return report;
}

async function observeTierB(): Promise<RunReport> {
  const root = await mkdtemp(join(tmpdir(), "wf-obs-b-"));
  const sideFile = join(root, "built.flag");
  const w = await assembleObserve(root, { sandbox: true });
  const t0 = Date.now();
  // 真实任务：编码交付（Tier B 旗舰场景）——命令验证产物副作用。
  // 装置局限（如实标注）：fake 模型只产文本不调工具——首轮命令必然 fail（文件不存在），
  // 修复轮也写不了文件——本旅程观测的是「命令验收的失败路径 + 回炉成本」；命令验收的
  // 成功路径由 unit 层 tier-b.test 覆盖（真 write 工具链不在 e2e 装置面）
  w.scripts.set("obs-model", [{ text: "I wrote the file via the write tool and the build passes.", delayMs: 100 }, { text: '{"summary": "artifact written and build passed"}', delayMs: 100 }]);
  const sent = await w.submit({ description: "build the artifact", prompt: `Write the file ${sideFile} with content ok, then finish`, result_schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } }, acceptance: { command: `test -f ${sideFile}` } });
  if (!sent.ok) throw new Error(sent.text);
  let childSession = "";
  for (const sid of await readdir(join(root, "workflows")).catch(() => [] as string[])) {
    const raw = await readFile(join(root, "workflows", sid, "journal.jsonl"), "utf8").catch(() => "");
    const m = /"sessionId":"([^"]+)"/.exec(raw);
    if (m?.[1] !== undefined) childSession = m[1];
  }
  await sleep(1_500);
  const sessions = await collectSessions(w, { "obs-parent": "父代理", ...(childSession !== "" ? { [childSession]: "任务子代理" } : {}) });
  const events = await journalEventsOf(root);
  const notifMatch = /\[workflow-notification\][^"\\]*/.exec(w.texts());
  const tokensTotal = sessions.reduce((acc, s) => acc + (s.usage !== undefined ? s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite : 0), 0);
  const report: RunReport = { tier: "Tier B（命令验收）", wallMs: Date.now() - t0, sessions, journalEvents: events, notifications: notifMatch?.[0] ?? "（未到）", tokensTotal };
  printReport(report);
  await w.dispose();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return report;
}

async function observeTierC(): Promise<RunReport> {
  const root = await mkdtemp(join(tmpdir(), "wf-obs-c-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: observation critic\nmodel: critic-model\n---\nYou review deliverables adversarially.");
  const w = await assembleObserve(root, { agentsDir });
  const t0 = Date.now();
  w.scripts.set("obs-model", [{ text: "The refactor moves auth into middleware; tests unchanged.", delayMs: 120 }]);
  w.scripts.set("critic-model", [{ text: '{"verdict":"fail","reopenProposals":["document the migration steps for reviewers"],"summary":"change lacks review guidance"}', delayMs: 200 }]);
  // 修复轮：任务子补文档后再过
  w.scripts.get("obs-model")?.push({ text: '{"summary": "refactor with migration doc", "steps": "see doc/migration.md"}', delayMs: 120 });
  w.scripts.get("critic-model")?.push({ text: '{"verdict":"pass"}', delayMs: 150 });
  const sent = await w.submit({ description: "reviewed refactor", prompt: "Summarize the auth refactor", critic: { type: "reviewer" } });
  if (!sent.ok) throw new Error(sent.text);
  await sleep(1_200);
  const sessions = await collectSessions(w, { "obs-parent": "父代理" });
  const events = await journalEventsOf(root);
  const notifMatch = /\[workflow-notification\][^"\\]*/.exec(w.texts());
  const tokensTotal = sessions.reduce((acc, s) => acc + (s.usage !== undefined ? s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite : 0), 0);
  const report: RunReport = { tier: "Tier C（critic 评审——fail 后 reopen）", wallMs: Date.now() - t0, sessions, journalEvents: events, notifications: notifMatch?.[0] ?? "（未到）", tokensTotal };
  printReport(report);
  await w.dispose();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return report;
}

async function observePassthrough(): Promise<RunReport> {
  const root = await mkdtemp(join(tmpdir(), "wf-obs-p-"));
  const w = await assembleObserve(root);
  const t0 = Date.now();
  w.scripts.set("obs-model", [{ text: "quick lookup done", delayMs: 80 }]);
  const sent = await w.submit({ description: "quick lookup", prompt: "find the config" }); // 无验收参数——直通
  if (!sent.ok) throw new Error(sent.text);
  await sleep(500);
  const sessions = await collectSessions(w, { "obs-parent": "父代理" });
  const events = await journalEventsOf(root);
  const tokensTotal = sessions.reduce((acc, s) => acc + (s.usage !== undefined ? s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite : 0), 0);
  const report: RunReport = { tier: "直通对照（无验收参数）", wallMs: Date.now() - t0, sessions, journalEvents: events, notifications: "agent-notification 原路径", tokensTotal };
  printReport(report);
  await w.dispose();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return report;
}

// ————————————————— 入口 —————————————————

const arg = process.argv[2] ?? "all";
const reports: RunReport[] = [];
if (arg === "a" || arg === "all") reports.push(await observeTierA());
if (arg === "b" || arg === "all") reports.push(await observeTierB());
if (arg === "c" || arg === "all") reports.push(await observeTierC());
if (arg === "all") reports.push(await observePassthrough());

console.log("\n════════ 评估汇总 ════════");
for (const r of reports) {
  console.log(`${r.tier}: ${(r.wallMs / 1000).toFixed(1)}s · tokens ${String(r.tokensTotal)} · journal ${String(r.journalEvents.length)} 事件`);
}
