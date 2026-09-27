// 线程域读侧命令（DESIGN §3.3）：会话状态/消息/条目/树/统计/命令清单/子代理/
// 弹窗只读查询（表内现值或事件日志折叠）；set_session_name 为标题直写会话
// （append+flush）。failure 路径单点经共享 respond。
import { createArchiveReader } from "@x-harness/session-persistence-jsonl";
import { pluginManagerService } from "@x-harness/plugin-manager";
import { hubError } from "../shared/errors.ts";
import { foldQueue } from "../shared/inbox-fold.ts";
import { WORKER_RESPONSE_SOFT_CAP } from "../shared/limits.ts";
import { entryWindowViewed } from "./entries-window.ts";
import { listCommands } from "./command-listing.ts";
import { currentDialOf, titleOf } from "./meta-state.ts";
import { respond, requireThread, wrapSyncHandler } from "./worker-commands.ts";
import type { CommandInput, Handler, WorkerRuntime } from "./worker-commands.ts";

function handleGetState(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_state" });
  if (session === undefined) return;
  const events = session.events();
  let messageCount = 0;
  for (const event of events) {
    if (event.type === "user/message" || event.type === "assistant/message") messageCount += 1;
  }
  respond(rt, {
    id: input.id,
    command: "get_state",
    data: {
      model: currentDialOf(events, rt.state.dial), // {provider, model} 复合形（字段改名声明 MIGRATION §4）
      isStreaming: rt.bridge.isStreaming(),
      isCompacting: rt.bridge.commandBusy(), // 命令执行中（BATCH3：本批唯一命令 compact，语义等价）
      sessionId: rt.state.threadId,
      sessionName: titleOf(events) ?? "",
      sessionFile: rt.state.sessionPath,
      messageCount,
      queue: foldQueue(events),
    },
  });
}

function handleGetInflight(rt: WorkerRuntime, input: CommandInput): void {
  if (requireThread(rt, { ...input, command: "get_inflight" }) === undefined) return;
  // bash 面：最新仍在跑的直执行（null ⇔ 无在跑——§3.3 收尾探测判据）
  respond(rt, { id: input.id, command: "get_inflight", data: { ...rt.inflightState.snapshot(), bash: rt.bash.readLatest() } });
}

/** get_messages 软上限判定（导出单测面）：预算按 UTF-8 字节累计（CJK 3 倍膨胀下
 *  UTF-16 码元计数会漏判），帧信封/转义留 4KiB 余量——超限以有界 failure 结算
 *  （超 worker 行限 = worker 被杀，thread_died） */
export function withinResponseBudget(messages: readonly unknown[], cap: number): boolean {
  let budget = cap - 4096;
  for (const message of messages) {
    budget -= Buffer.byteLength(JSON.stringify(message), "utf8");
    if (budget < 0) return false;
  }
  return true;
}

function handleGetMessages(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_messages" });
  if (session === undefined) return;
  const messages = session.deriveMessages();
  if (!withinResponseBudget(messages, WORKER_RESPONSE_SOFT_CAP)) {
    respond(rt, { id: input.id, command: "get_messages", error: hubError("thread_limit", "response too large; use get_entries") });
    return;
  }
  respond(rt, { id: input.id, command: "get_messages", data: { messages } });
}

function handleGetEntries(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_entries" });
  if (session === undefined) return;
  const result = entryWindowViewed(session.events(), {
    ...(typeof input.since === "number" ? { since: input.since } : {}),
    ...(typeof input.before === "number" ? { before: input.before } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(input.view !== undefined ? { view: input.view } : {}),
  });
  if (!result.ok) {
    respond(rt, { id: input.id, command: "get_entries", error: hubError(result.code, result.reason) });
    return;
  }
  // data 形状与 host 直读路径闭合：解构判别联合，不带 ok 字段
  respond(rt, { id: input.id, command: "get_entries", data: { entries: result.entries, leafSeq: result.leafSeq, hasMore: result.hasMore } });
}

interface SubtreeWalk {
  readonly headers: readonly { id: unknown; parentSession?: unknown; agentId?: unknown }[];
  readonly seen: Set<string>;
  readonly children: string[];
}

/** 全子孙收集（BFS 沿 parentSession——排除子代理会话；环防御 + 深度封顶） */
export function descendantsOf(root: string, headers: readonly { id: unknown; parentSession?: unknown; agentId?: unknown }[]): string[] {
  const walk: SubtreeWalk = { headers, seen: new Set<string>([root]), children: [] };
  let frontier = [root];
  for (let depth = 0; depth < headers.length && frontier.length > 0; depth += 1) {
    frontier = expandFrontier(walk, frontier);
  }
  return walk.children;
}

function expandFrontier(walk: SubtreeWalk, frontier: readonly string[]): string[] {
  const next: string[] = [];
  for (const parent of frontier) {
    for (const header of walk.headers) {
      const id = String(header.id);
      if (header.agentId !== undefined || String(header.parentSession) !== parent || walk.seen.has(id)) continue;
      walk.seen.add(id);
      walk.children.push(id);
      next.push(id);
    }
  }
  return next;
}

/** 会话 fork 谱系（DESIGN §3.3）：ancestors 沿 header.parentSession 链（不含自身）；
 *  children = parentSession === id 的 headers（排除子代理会话——header.agentId 滤除） */
async function handleGetTree(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  const session = requireThread(rt, { ...input, command: "get_tree" });
  if (session === undefined) return;
  try {
    const headers = await createArchiveReader(rt.sessionsRoot).listHeaders();
    const byId = new Map(headers.map((header) => [String(header.id), header]));
    const ancestors: string[] = [];
    let cursor = byId.get(rt.state.threadId)?.parentSession;
    while (cursor !== undefined) {
      const id = String(cursor);
      if (ancestors.includes(id)) break; // 环防御（数据面异常不死循环）
      ancestors.push(id);
      cursor = byId.get(id)?.parentSession;
    }
    const children = descendantsOf(rt.state.threadId, headers);
    respond(rt, {
      id: input.id,
      command: "get_tree",
      data: { ancestors, children, leafSeq: session.events().length - 1 },
    });
  } catch (error) {
    process.stderr.write(`hub:worker: get_tree walk failed: ${String(error)}\n`);
    respond(rt, { id: input.id, command: "get_tree", error: hubError("session_unreadable", "Session file not readable") });
  }
}

/** 计数折叠（纯计数面——非 token 域无口径问题；token/cost 面归 token-meter 单一真相）
 *  CONTEXT-TOKEN-UNIFICATION §3.2：原 foldStats 的 usage 折叠删除——三套折叠归一
 *  （旧折漏 assistant/attempt 计费、无垃圾校验、total 用 totalTokens ?? input+output
 *  与 meter 口径分叉）。 */
function countStats(events: readonly { type: string }[]): { userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number } {
  const out = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 };
  for (const event of events) {
    if (event.type === "user/message") out.userMessages += 1;
    else if (event.type === "assistant/message") out.assistantMessages += 1;
    else if (event.type === "tool/call") out.toolCalls += 1;
    else if (event.type === "tool/result") out.toolResults += 1;
  }
  return out;
}

function handleGetSessionStats(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_session_stats" });
  if (session === undefined) return;
  const counts = countStats(session.events());
  // token/cost 面：token-meter 单一真相（attempt 计费/垃圾整丢/溢出 fail-closed 与
  // analytics 同律）；未知/溢出会话 → undefined → 全零形态降级（H3——不 500 不悬空）
  const usage = rt.state.world?.meter.usageOf(session.id);
  respond(rt, {
    id: input.id,
    command: "get_session_stats",
    data: {
      userMessages: counts.userMessages,
      assistantMessages: counts.assistantMessages,
      toolCalls: counts.toolCalls,
      toolResults: counts.toolResults,
      tokens: {
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        total: usage?.totalTokens ?? 0,
        ...(usage?.costTotal !== undefined ? { cost: usage.costTotal } : {}),
      },
    },
  });
}

/** 插件分析面（本地结构形状——host-hub 不 import 插件包；经 plugin-manager token
 *  按名注册表取服务，真解耦——docs/PLUGINS.md 契约 5）。统计域 = 会话全历史
 *  （usage 事实经 token-meter 事实层：resume/重开经冷启动含全历史实报；子代理
 *  usage 计入全局累计） */
interface TokenAnalyticsFace {
  breakdown(sessionId?: string): Record<string, number>;
  sessionOutput(session: string): number;
}

function handleGetTokenAnalytics(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_token_analytics" });
  if (session === undefined) return; // unknown_thread 分族先行（自愈语义不可劫持）
  const world = rt.state.world;
  const svc = world?.ctx.tryUse(pluginManagerService);
  const token = svc?.serviceToken("token-analytics");
  // tryUse 而非 use：收殓窗口（uninstall 回卷中、token 表未清）下 use 会抛——
  // 能力缺席一律 capability_plugin，不被 internal 兜底族劫持
  const analytics = world !== undefined && token !== undefined ? (world.ctx.tryUse(token) as unknown as TokenAnalyticsFace | undefined) : undefined;
  if (analytics === undefined) {
    respond(rt, { id: input.id, command: "get_token_analytics", error: hubError("capability_plugin", "token analytics plugin not loaded") });
    return;
  }
  respond(rt, {
    id: input.id,
    command: "get_token_analytics",
    data: { breakdown: analytics.breakdown(rt.state.threadId), sessionOutput: analytics.sessionOutput(rt.state.threadId) },
  });
}

async function handleSetSessionName(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  const session = requireThread(rt, { ...input, command: "set_session_name" });
  if (session === undefined) return;
  const name = input.name;
  if (typeof name !== "string" || name.trim() === "") {
    respond(rt, { id: input.id, command: "set_session_name", error: hubError("invalid_input", "invalid name: non-empty string required") });
    return;
  }
  const append = session.append("session/meta", { key: "title", value: name });
  if (!append.ok) {
    respond(rt, { id: input.id, command: "set_session_name", error: hubError("io_failed", append.reason) });
    return;
  }
  const flushed = await rt.state.world?.store.flush(session.id);
  if (flushed !== undefined && !flushed.ok) {
    process.stderr.write(`hub:worker: set_session_name flush failed: ${flushed.reason}\n`);
    respond(rt, { id: input.id, command: "set_session_name", error: hubError("io_failed", flushed.reason) });
    return;
  }
  respond(rt, { id: input.id, command: "set_session_name" });
}

async function handleGetCommands(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  if (requireThread(rt, { ...input, command: "get_commands" }) === undefined) return;
  respond(rt, {
    id: input.id,
    command: "get_commands",
    data: await listCommands({ skillsDirs: rt.state.skillsDirs, disabled: rt.state.skillsDisabled, commands: rt.state.commands?.list() ?? [] }),
  });
}

function handleGetForkMessages(rt: WorkerRuntime, input: CommandInput): void {
  const session = requireThread(rt, { ...input, command: "get_fork_messages" });
  if (session === undefined) return;
  const forkable: Array<{ seq: number; text: string }> = [];
  for (const node of session.surface()) {
    const event = node.event;
    if (event.type !== "user/message") continue;
    const text = event.data.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "image") return `[image: ${block.mediaType}]`; // 纯图行可见性——不留整行缺席
        return "";
      })
      .join("");
    if (text !== "") forkable.push({ seq: event.seq, text });
  }
  respond(rt, { id: input.id, command: "get_fork_messages", data: forkable });
}

async function handleGetSubagents(rt: WorkerRuntime, input: CommandInput): Promise<void> {
  if (requireThread(rt, { ...input, command: "get_subagents" }) === undefined) return;
  const view = rt.state.delegation;
  const rows = view === undefined ? [] : await view.list(rt.state.threadId as never);
  respond(rt, { id: input.id, command: "get_subagents", data: { subagents: rows } });
}

function handleGetPendingDialogs(rt: WorkerRuntime, input: CommandInput): void {
  if (requireThread(rt, { ...input, command: "get_pending_dialogs" }) === undefined) return;
  respond(rt, { id: input.id, command: "get_pending_dialogs", data: { dialogs: rt.broker.pendingAll() } });
}

/** 插件装载快照（host plugins/list 归并输入）：pluginManagerService.list() 的
 *  本 thread 视图——name/mode/status。观察者命令：不重置 idle 计时。 */
function handleGetPlugins(rt: WorkerRuntime, input: CommandInput): void {
  if (requireThread(rt, { ...input, command: "get_plugins" }) === undefined) return;
  const svc = rt.state.world?.ctx.tryUse(pluginManagerService);
  const loaded = svc === undefined ? [] : svc.list().map((record) => ({ name: record.name, mode: record.mode, status: record.status }));
  respond(rt, { id: input.id, command: "get_plugins", data: { loaded } });
}

/** 读侧命令注册（注册表由 worker-commands 组装——保持单点分派面） */
export function registerReadCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("get_state", wrapSyncHandler((input) => handleGetState(rt, input)));
  handlers.set("get_inflight", wrapSyncHandler((input) => handleGetInflight(rt, input)));
  handlers.set("get_messages", wrapSyncHandler((input) => handleGetMessages(rt, input)));
  handlers.set("get_entries", wrapSyncHandler((input) => handleGetEntries(rt, input)));
  handlers.set("get_tree", (input) => handleGetTree(rt, input));
  handlers.set("get_session_stats", wrapSyncHandler((input) => handleGetSessionStats(rt, input)));
  handlers.set("get_token_analytics", wrapSyncHandler((input) => handleGetTokenAnalytics(rt, input)));
  handlers.set("set_session_name", (input) => handleSetSessionName(rt, input));
  handlers.set("get_commands", (input) => handleGetCommands(rt, input));
  handlers.set("get_fork_messages", wrapSyncHandler((input) => handleGetForkMessages(rt, input)));
  handlers.set("get_subagents", (input) => handleGetSubagents(rt, input));
  handlers.set("get_plugins", wrapSyncHandler((input) => handleGetPlugins(rt, input)));
  handlers.set("get_pending_dialogs", wrapSyncHandler((input) => handleGetPendingDialogs(rt, input)));
}
