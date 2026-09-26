// 基准对比 e2e：subagent 直通 vs workflow 三档——同一任务集、真模型、可量化基准。
//
// 基准维度（每任务 × 两形态）：
//   质量：交付物达标率（人工可核的硬判据——本基准用确定性判定器打分，见 RUBRIC）
//   成本：tokens 四字段 + 计费当量；LLM 调用次数（llm.chat span 计数）
//   时延：wall-clock
//   过程：journal 事件（回炉轮次）/ span 时间线
//   保障：无响应/超时/坏输出时两形态各自的表现（workflow 的验收兜底 vs 直通的静默）
//
// 任务集（5 题，覆盖结构化抽取/约束生成/数据变换/一致性核查/格式迁移——不依赖外部工具，
//   真模型一次对话可完成，且结果可确定性评分）：
//   T1 schema 抽取：从散文提炼 JSON（字段级判分）
//   T2 约束生成：生成满足 3 条硬约束的 JSON（约束逐条判）
//   T3 数据变换：输入行集，输出按规则的映射（逐行比对）
//   T4 一致性核查：找出矛盾对（集合比对）
//   T5 格式迁移：markdown→严格 CSV（逐格比对）
//
// 用法：bun packages/e2e/src/wf-bench.mts [--tasks 1,2] [--runs 3]

import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SessionId } from "@x-harness/session";
import type { Plugin } from "@x-harness/core";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmPlugin, llmRuntime, createOpenaiCompatAdapter } from "@x-harness/llm";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { systemPromptPlugin } from "@x-harness/system-prompt";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { agentLoopPlugin, agentLoopServiceToken } from "@x-harness/agent-loop";
import { createTaskToolsPlugin } from "@x-harness/task-tools";
import { createAgentDelegationPlugin, delegationView } from "@x-harness/agent-delegation";
import { createAgentWorkflowPlugin } from "@x-harness/agent-workflow";
import { sqliteTelemetry, sqliteTelemetryPlugin, createBunSqliteExecutor } from "@x-harness/telemetry-sqlite";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(() => {
    resolve();
  }, ms);
});

// ————————————————— 任务集与判分器 —————————————————

interface BenchTask {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  /** workflow 档的 schema（Tier A——直通形态无 schema 约束） */
  readonly schema?: unknown;
  /** 判分器：交付文本 → {得分 0..1, 明细}（确定性——不依赖模型评 */
  readonly score: (deliverable: string) => { readonly points: number; readonly detail: string };
}

/** 判分输入清洗：剥 usage 行（通知尾的计量块——greedy JSON regex 会误吞） */
function stripUsage(text: string): string {
  return text.split("\n").filter((l) => !l.startsWith("usage:")).join("\n");
}

const TASKS: readonly BenchTask[] = [
  {
    id: "T1",
    name: "schema 抽取",
    prompt: `从以下散文提取结构化信息，输出单个 JSON（无其他文字）：
"项目 Orion 原定 3 月上线，因依赖的支付网关联调延期到 5 月 12 日。负责人是 Lin Zhao，
风险等级高，主要风险是第三方回调超时未覆盖测试。"
JSON 形状：{"project": string, "originalDate": string, "currentDate": string, "owner": string, "risk": "low"|"medium"|"high", "topRisk": string}`,
    schema: { type: "object", required: ["project", "originalDate", "currentDate", "owner", "risk", "topRisk"], properties: { project: { type: "string" }, originalDate: { type: "string" }, currentDate: { type: "string" }, owner: { type: "string" }, risk: { enum: ["low", "medium", "high"] }, topRisk: { type: "string" } } },
    score: (raw) => {
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m === null) return { points: 0, detail: "无 JSON" };
      try {
        const j = JSON.parse(m[0]) as Record<string, unknown>;
        const want: Record<string, unknown> = { project: "Orion", owner: "Lin Zhao", risk: "high" };
        let hits = 0;
        let total = 0;
        for (const [k, v] of Object.entries(want)) {
          total += 1;
          if (String(j[k]).includes(String(v))) hits += 1;
        }
        for (const k of ["originalDate", "currentDate", "topRisk"]) {
          total += 1;
          if (typeof j[k] === "string" && (j[k] as string).length > 0) hits += 1;
        }
        return { points: hits / total, detail: `${String(hits)}/${String(total)} 字段达标` };
      } catch {
        return { points: 0, detail: "JSON 解析失败" };
      }
    },
  },
  {
    id: "T2",
    name: "约束生成",
    prompt: `生成一个满足全部约束的 JSON 对象（无其他文字）：
1) "id" 是 4 位十六进制字符串（如 "a3f1"）
2) "tags" 恰含 3 个互不重复的小写单词
3) "priority" ∈ 1..5 且为奇数
形状：{"id": string, "tags": string[], "priority": number}`,
    schema: { type: "object", required: ["id", "tags", "priority"], properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, priority: { type: "number" } } },
    score: (raw) => {
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m === null) return { points: 0, detail: "无 JSON" };
      try {
        const j = JSON.parse(m[0]) as { id?: unknown; tags?: unknown; priority?: unknown };
        let hits = 0;
        if (typeof j.id === "string" && /^[0-9a-f]{4}$/.test(j.id)) hits += 1;
        if (Array.isArray(j.tags) && j.tags.length === 3 && new Set(j.tags.map(String)).size === 3 && j.tags.every((t) => /^[a-z]+$/.test(String(t)))) hits += 1;
        if (typeof j.priority === "number" && j.priority >= 1 && j.priority <= 5 && j.priority % 2 === 1) hits += 1;
        return { points: hits / 3, detail: `约束 ${String(hits)}/3` };
      } catch {
        return { points: 0, detail: "JSON 解析失败" };
      }
    },
  },
  {
    id: "T3",
    name: "数据变换",
    prompt: `按规则变换以下行集，输出 JSON 数组（无其他文字）：
输入：
apple,10,3.5
banana,5,2.0
cherry,0,8.0
规则：每行 → {"item": 名称, "value": 数量×单价 的数值, "stock": 数量}
数量为 0 的行丢弃。`,
    schema: { type: "array", items: { type: "object", required: ["item", "value", "stock"], properties: { item: { type: "string" }, value: { type: "number" }, stock: { type: "number" } } } },
    score: (raw) => {
      const m = /\[[\s\S]*\]/.exec(raw);
      if (m === null) return { points: 0, detail: "无 JSON 数组" };
      try {
        const j = JSON.parse(m[0]) as Array<{ item?: unknown; value?: unknown; stock?: unknown }>;
        const want = [
          { item: "apple", value: 35, stock: 10 },
          { item: "banana", value: 10, stock: 5 },
        ];
        const ok = want.length === j.length && want.every((w, i) => String(j[i]?.item) === w.item && Math.abs(Number(j[i]?.value) - w.value) < 0.01 && Number(j[i]?.stock) === w.stock);
        let points: number;
        if (ok) points = 1;
        else if (j.length === want.length) points = 0.5;
        else points = 0;
        return { points, detail: ok ? "全部行正确" : `行数 ${String(j.length)}（期望 2，cherry 应被丢弃）` };
      } catch {
        return { points: 0, detail: "JSON 解析失败" };
      }
    },
  },
  {
    id: "T4",
    name: "一致性核查",
    prompt: `找出以下陈述中互相矛盾的对，输出 JSON 数组（无其他文字）：
S1: 系统每日凌晨 2 点做全量备份
S2: 备份窗口不早于凌晨 3 点
S3: 增量备份每小时执行一次
S4: 全量备份持续 90 分钟
输出形状：[{"a": "S1", "b": "S2", "reason": string}]（只列真矛盾——约束冲突/时间不可满足）`,
    schema: { type: "array", items: { type: "object", required: ["a", "b", "reason"], properties: { a: { type: "string" }, b: { type: "string" }, reason: { type: "string" } } } },
    score: (raw) => {
      const m = /\[[\s\S]*\]/.exec(raw);
      if (m === null) return { points: 0, detail: "无 JSON 数组" };
      try {
        const j = JSON.parse(m[0]) as Array<{ a?: unknown; b?: unknown }>;
        const pairs = j.map((p) => `${String(p.a)}-${String(p.b)}`).sort().join(",");
        const correct = "S1-S2"; // 2 点开始 vs 不早于 3 点——唯一真矛盾（S4 与两者均相容）
        if (pairs === correct) return { points: 1, detail: "矛盾对正确" };
        if (j.some((p) => `${String(p.a)}-${String(p.b)}` === correct || `${String(p.b)}-${String(p.a)}` === correct)) return { points: 0.5, detail: "含正确对但有误报" };
        return { points: 0, detail: `输出 ${pairs}` };
      } catch {
        return { points: 0, detail: "JSON 解析失败" };
      }
    },
  },
  {
    id: "T5",
    name: "格式迁移",
    prompt: `把以下 markdown 表转成严格 CSV（首行表头，逗号分隔，无多余空行/反引号，数值去格式）：
| 模块 | 覆盖率 | 备注 |
| --- | --- | --- |
| auth | 92.5% | 新增中间件 |
| api | 78% | 遗留代码 |`,
    schema: { type: "string" },
    score: (raw) => {
      const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("```"));
      if (lines.length !== 3) return { points: 0, detail: `行数 ${String(lines.length)}（期望 3）` };
      const want = ["模块,覆盖率,备注", "auth,92.5%,新增中间件", "api,78%,遗留代码"];
      const hits = lines.filter((l, i) => l === want[i]).length;
      return { points: hits / 3, detail: `${String(hits)}/3 行精确匹配` };
    },
  },
];

// ————————————————— 装置 —————————————————

interface BenchWorld {
  readonly spawnedSessions: () => readonly string[];
  readonly ctx: ReturnType<typeof createContext>;
  readonly loop: import("@x-harness/agent-loop").AgentLoopService;
  readonly tel: ReturnType<typeof sqliteTelemetry.get extends () => infer T ? () => T : never>;
  readonly root: string;
  readonly texts: () => string;
  readonly dispatch: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  readonly dispose: () => Promise<void>;
}

async function loadEnv(): Promise<Record<string, string>> {
  const raw = await readFile(join(import.meta.dir, "..", ".env"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m !== null) env[m[1]] = m[2];
  }
  return env;
}

async function assembleBench(root: string, env: Record<string, string>, options: { readonly workflow: boolean }): Promise<BenchWorld> {
  const db = new Database(join(root, "bench.db"));
  const ctx = createContext();
  const plugins: readonly Plugin[] = [
    sessionPlugin,
    toolsPlugin,
    systemPromptPlugin,
    llmPlugin,
    agentLoopPlugin,
    createTaskToolsPlugin(),
    sqliteTelemetryPlugin({ db: createBunSqliteExecutor(db), resource: { serviceName: `bench-${options.workflow ? "wf" : "sub"}` } }),
    createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: root, worktreeSweep: false }),
    ...(options.workflow ? [createAgentWorkflowPlugin({ root: join(root, "workflows"), mainSession: "bench-parent" as SessionId })] : []),
  ];
  await loadPlugins(ctx, plugins);
  const loop = ctx.use(agentLoopServiceToken);
  const tel = ctx.use(sqliteTelemetry);
  ctx.use(llmRuntime).registerAdapter(createOpenaiCompatAdapter({ name: "deepseek", baseUrl: env["DEEPSEEK_BASE_URL"]!, apiKey: env["DEEPSEEK_APIPKEY"]! }));
  const parent = await loop.create({ session: { id: "bench-parent" as SessionId }, agent: { model: "deepseek-v4.1-flash", provider: "deepseek" } });
  if (!parent.ok) throw new Error(parent.reason);
  const registry = ctx.use(toolRegistry);
  // spawn 捕获（子会话 token 采集——任务子与 critic 都经此面）
  const view = ctx.tryUse(delegationView);
  const spawned: string[] = [];
  if (view !== undefined) {
    const realSpawn = view.spawnManaged.bind(view);
    (view as unknown as { spawnManaged: typeof view.spawnManaged }).spawnManaged = async (caller, input) => {
      const r = await realSpawn(caller, input);
      if (r.ok) {
        const sid = /session (\S+?)\)/.exec(r.text)?.[1];
        if (sid !== undefined) spawned.push(sid);
      }
      return r;
    };
  }
  return {
    spawnedSessions: () => [...spawned],
    ctx,
    loop,
    tel,
    root,
    texts: () => {
      const evts = ctx.use(sessionStore).get("bench-parent" as SessionId)?.events() ?? [];
      const out: string[] = [];
      for (const e of evts) {
        if (e.type !== "user/message" && e.type !== "agent/message") continue;
        const content = (e.data as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text !== undefined) out.push(block.text);
        }
      }
      return out.join("\n");
    },
    dispatch: async (name, args) => {
      const made = await registry.dispatch({ callId: `b-${String(Math.random()).slice(2, 8)}`, name, args, signal: new AbortController().signal, session: "bench-parent" as SessionId });
      return { ok: made.isError !== true, text: String(made.content) };
    },
    dispose: async () => {
      await parent.value.dispose();
      await ctx.dispose();
      db.close();
    },
  };
}

// ————————————————— 两形态执行器 —————————————————

interface TaskResult {
  readonly task: string;
  readonly mode: "subagent" | "workflow";
  readonly run: number;
  readonly wallMs: number;
  readonly score: number;
  readonly scoreDetail: string;
  readonly llmCalls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly steps: number;
  readonly journalEvents: number;
  readonly journalTail: string;
  readonly deliverable: string;
}

/** 通知尾的 usage 行解析（两形态统一口径） */
function usageOfNotification(notifBlock: string): { input?: number; output?: number; cacheRead?: number } | undefined {
  const m = /usage: (\{[^}]*\})/.exec(notifBlock);
  return m !== null ? (JSON.parse(m[1]) as { input?: number; output?: number; cacheRead?: number }) : undefined;
}

/** 子会话轮数（通知 session 行 → 会话事件的 turn/start 计数） */
function childTurnsOf(w: BenchWorld, notifBlock: string): number {
  const childIdMatch = /session ([A-Za-z0-9._-]+)/.exec(notifBlock);
  if (childIdMatch?.[1] === undefined) return 0;
  const store = w.ctx.use(sessionStore);
  let turns = 0;
  for (const e of store.get(childIdMatch[1] as SessionId)?.events() ?? []) {
    if (e.type === "turn/start") turns += 1;
  }
  return turns;
}

/** 等待完成通知并取末段块（两形态共用——超时返回空串） */
async function awaitNotification(w: BenchWorld, marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    if (w.texts().includes(marker)) break;
  }
  const texts = w.texts();
  const idx = texts.lastIndexOf(marker);
  return idx >= 0 ? texts.slice(idx, idx + 6_000) : "";
}

/** 直通形态：agent_spawn（无验收）——模型把子代理的完成通知文本当交付物 */
async function runViaSubagent(w: BenchWorld, task: BenchTask): Promise<Omit<TaskResult, "mode" | "run" | "task">> {
  const t0 = Date.now();
  const spawned = await w.dispatch("agent_spawn", { description: task.name, prompt: task.prompt });
  if (!spawned.ok) return { wallMs: Date.now() - t0, score: 0, scoreDetail: `spawn 失败：${spawned.text.slice(0, 80)}`, llmCalls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, steps: 1, journalEvents: 0, journalTail: "", deliverable: "" };
  const notifBlock = await awaitNotification(w, "agent-notification", 90_000);
  const childTurns = childTurnsOf(w, notifBlock);
  
  // 子会话 token（从通知里拿 agent id 不可靠——直接找最新 spawned 子会话：经 texts 不可得，
  // 简化：本次基准用父会话 llm.chat 数+token 做两形态共同面，子会话侧由 workflow 形态的
  // journal+spawn 捕获补充。直通形态子会话 token 计入父侧不可行——用通知块近似无意义。
  // 诚实口径：直通形态记录父会话成本（调度开销），子会话成本两形态同源（同模型同 prompt 前缀）。
  const u = usageOfNotification(notifBlock);
  return {
    wallMs: Date.now() - t0,
    score: task.score(stripUsage(notifBlock)).points,
    scoreDetail: task.score(stripUsage(notifBlock)).detail,
    llmCalls: u === undefined ? 0 : 1,
    tokensIn: u?.input ?? 0,
    tokensOut: u?.output ?? 0,
    cacheRead: u?.cacheRead ?? 0,
    steps: 1 + childTurns, // 父 dispatch 1 + 子轮数
    journalEvents: 0,
    journalTail: "（直通无 journal）",
    deliverable: notifBlock.slice(0, 200),
  };
}

/** workflow 形态：workflow_submit（Tier A schema——回炉由验收驱动） */
async function runViaWorkflow(w: BenchWorld, task: BenchTask): Promise<Omit<TaskResult, "mode" | "run" | "task">> {
  const t0 = Date.now();
  const sent = await w.dispatch("workflow_submit", { description: task.name, prompt: task.prompt, ...(task.schema !== undefined ? { result_schema: task.schema } : {}) });
  if (!sent.ok) return { wallMs: Date.now() - t0, score: 0, scoreDetail: `提交失败：${sent.text.slice(0, 80)}`, llmCalls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, steps: 1, journalEvents: 0, journalTail: "", deliverable: "" };
  const notif = await awaitNotification(w, "workflow-notification", 120_000);
  // journal（回炉轮次证据）
  let journalTail = "";
  for (const rid of await readdir(join(w.root, "workflows")).catch(() => [] as string[])) {
    const raw = await readFile(join(w.root, "workflows", rid, "journal.jsonl"), "utf8").catch(() => "");
    journalTail = raw.split("\n").filter((l) => l !== "").map((l) => { try { return (JSON.parse(l) as { type: string }).type; } catch { return "?"; } }).join("→");
  }
  // 子会话成本：spawn 捕获面聚合（任务子 + critic×轮——比单条 usage 行完整）
  await sleep(1_500); // telemetry 落盘时序余量
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let llmCalls = 0;
  let childTurns = 0;
  const store = w.ctx.use(sessionStore);
  for (const sid of w.spawnedSessions()) {
    const su = w.tel.usageOf(sid as SessionId);
    if (su !== undefined) {
      tokensIn += Number(su.inputTokens);
      tokensOut += Number(su.outputTokens);
      cacheRead += Number(su.cacheRead);
    }
    llmCalls += w.tel.spansOf(sid as SessionId).filter((sp) => sp.name === "llm.chat" && sp.endMs !== null).length;
    for (const e of store.get(sid as SessionId)?.events() ?? []) {
      if (e.type === "turn/start") childTurns += 1;
    }
  }
  const journalEvents = journalTail.split("→").filter((t) => t !== "" && t !== "?").length;
  // deliverable（通知里的 deliverable: 行——B-9 回传）
  const dm = /deliverable:\\n?([\s\S]{0,600})/.exec(notif) ?? /deliverable":?"?([^"]{0,400})/.exec(notif);
  const deliverable = dm?.[1] ?? "";
  const cleanedNotif = notif.split("\n").filter((l) => !l.startsWith("usage:")).join("\n");
  const scored = task.score(deliverable !== "" ? deliverable : cleanedNotif);
  return {
    wallMs: Date.now() - t0,
    score: scored.points,
    scoreDetail: scored.detail,
    llmCalls,
    tokensIn,
    tokensOut,
    cacheRead,
    steps: 1 + childTurns, // 父 dispatch 1 + 全部子代理轮数（含 critic）
    journalEvents,
    journalTail,
    deliverable: deliverable.slice(0, 200),
  };
}

// ————————————————— 主流程与报告 —————————————————

function argTasks(): readonly BenchTask[] {
  const spec = process.argv.find((a) => a.startsWith("--tasks="));
  if (spec === undefined) return TASKS;
  const ids = spec.slice(8).split(",").map((id) => (/^\d$/.test(id) ? `T${id}` : id));
  return TASKS.filter((t) => ids.includes(t.id));
}

function argRuns(): number {
  const spec = process.argv.find((a) => a.startsWith("--runs="));
  return spec === undefined ? 1 : Math.max(1, Number.parseInt(spec.slice(7), 10));
}

const env = await loadEnv();
const tasks = argTasks();
const runs = argRuns();
const results: TaskResult[] = [];

for (let run = 1; run <= runs; run += 1) {
  for (const task of tasks) {
    // 直通形态（每任务独立 world——父会话 token 累积会污染跨任务对比）
    {
      const root = await mkdtemp(join(tmpdir(), `bench-sub-${task.id}-`));
      const w = await assembleBench(root, env, { workflow: false });
      try {
        const r = await runViaSubagent(w, task);
        results.push({ task: task.id, mode: "subagent", run, ...r });
      } finally {
        await w.dispose();
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
    // workflow 形态
    {
      const root = await mkdtemp(join(tmpdir(), `bench-wf-${task.id}-`));
      const w = await assembleBench(root, env, { workflow: true });
      try {
        const r = await runViaWorkflow(w, task);
        results.push({ task: task.id, mode: "workflow", run, ...r });
      } finally {
        await w.dispose();
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

// 报告
console.log("\n════════════════ 基准对比报告 ════════════════");
console.log(`任务 ${String(tasks.length)} × 形态 2 × 轮次 ${String(runs)} = ${String(results.length)} 次执行\n`);

for (const task of tasks) {
  console.log(`── ${task.id} ${task.name} ──`);
  for (const mode of ["subagent", "workflow"] as const) {
    const rs = results.filter((r) => r.task === task.id && r.mode === mode);
    if (rs.length === 0) continue;
    const avgScore = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    const avgWall = rs.reduce((a, r) => a + r.wallMs, 0) / rs.length;
    const avgIn = rs.reduce((a, r) => a + r.tokensIn, 0) / rs.length;
    const avgOut = rs.reduce((a, r) => a + r.tokensOut, 0) / rs.length;
    const avgCalls = rs.reduce((a, r) => a + r.llmCalls, 0) / rs.length;
    const r0 = rs[0]!;
    const avgSteps = rs.reduce((a, r) => a + r.steps, 0) / rs.length;
    console.log(`  ${mode === "subagent" ? "直通" : "workflow"}: 质量 ${(avgScore * 100).toFixed(0)}%（${r0.scoreDetail}）· ${(avgWall / 1000).toFixed(1)}s · 步骤 ${avgSteps.toFixed(1)} · 子侧 in ${String(Math.round(avgIn))}/out ${String(Math.round(avgOut))} · llm.chat ${avgCalls.toFixed(1)}${mode === "workflow" ? ` · journal ${String(r0.journalEvents)} 事件` : ""}`);
    if (mode === "workflow") console.log(`    journal: ${r0.journalTail}`);
  }
}

// 汇总
const agg = (mode: "subagent" | "workflow") => {
  const rs = results.filter((r) => r.mode === mode);
  return {
    score: rs.reduce((a, r) => a + r.score, 0) / Math.max(1, rs.length),
    wall: rs.reduce((a, r) => a + r.wallMs, 0) / Math.max(1, rs.length),
    steps: rs.reduce((a, r) => a + r.steps, 0) / Math.max(1, rs.length),
  };
};
const s = agg("subagent");
const f = agg("workflow");
console.log(`\n════════════════ 汇总 ════════════════`);
console.log(`直通:     平均质量 ${(s.score * 100).toFixed(0)}% · 平均 ${(s.wall / 1000).toFixed(1)}s · 平均步骤 ${s.steps.toFixed(1)}`);
console.log(`workflow: 平均质量 ${(f.score * 100).toFixed(0)}% · 平均 ${(f.wall / 1000).toFixed(1)}s · 平均步骤 ${f.steps.toFixed(1)}`);
console.log(`质量差: ${((f.score - s.score) * 100).toFixed(0)}pp · 时延差: ${((f.wall - s.wall) / 1000).toFixed(1)}s`);
