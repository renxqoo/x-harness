// REPL 主循环（docs/CLI.md §2.3/§2.7）：行分派（steer/followup/slash）、Ctrl+C 状态机
// （running=cancel；ask 挂起=强制关闭提问→deny+cancel；idle 双击 500ms=退出）、
// 退出清理（当前 handle dispose 后返回，ctx 归 main）。迟到输入一律捕获降级不炸。

import type { AgentHandle, AgentLoopService, AgentOptions } from "@x-harness/agent-loop";
import { agentAssistantStream } from "@x-harness/agent-loop";
import type { Result } from "@x-harness/core";
import type { CliArgs } from "./parse-cli-args.ts";
import { resolveToolNames } from "./resolve-agent-options.ts";
import { formatSessionSummary, formatTurnLine } from "./format-usage.ts";
import type { ProvidersConfig } from "./providers-file.ts";
import { mainSessions } from "./resolve-session.ts";
import { createReplTerminal } from "./repl-terminal.ts";
import { compactionRunner } from "@x-harness/compaction";
import { exportSession } from "./export-session.ts";
import { createStreamRenderer } from "./render-stream.ts";
import { runSlashCommand } from "./slash-commands.ts";
import type { SlashDeps, SlashDial } from "./slash-commands.ts";
import type { World } from "./build-world.ts";
import { delegationView } from "@x-harness/agent-delegation";
import { workflowView } from "@x-harness/agent-workflow";
import type { SessionId } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import pkg from "../package.json";

const DOUBLE_PRESS_MS = 500;

export interface ReplIO {
  readonly write: (text: string) => void;
  readonly stdin: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  /** 信号面注入（生产 = process.on）；缺席 = 不接信号（进程默认语义，测试安全）。
   *  SIGINT 必须接线：规范模式 pty（e2e）下 ^C 由内核直投，readline 的 SIGINT 事件只在
   *  raw 模式触发——两个来源共用同一状态机，幂等不双触发 */
  readonly onSignal?: (kind: "SIGINT" | "SIGTERM" | "SIGHUP", callback: () => void) => void;
}

export interface ReplInput {
  readonly world: World;
  readonly handle: AgentHandle;
  readonly baseOptions: AgentOptions;
  readonly args: CliArgs;
  readonly config: ProvidersConfig;
  readonly sessionRoot: string;
  readonly persist: boolean;
  readonly io: ReplIO;
  /** 启动后依序执行的初始提示（交互模式的位置参数/管道 stdin 拼接产物） */
  readonly initialPrompts?: readonly string[];
  /** broker 提问面接线：REPL 终端就绪后回传 question（Ctrl+C 强制关闭 → undefined → deny） */
  readonly wireAsk?: (ask: (prompt: string) => Promise<string | undefined>) => void;
  /** 退出面接线（stdout EPIPE 等外部断裂触发清理退出） */
  readonly wireQuit?: (quit: (code: number) => void) => void;
}

/** 行分派纯函数：空行忽略；slash 行透传；running 时普通文本 = steer */
export type LineAction =
  | { readonly kind: "ignore" }
  | { readonly kind: "steer"; readonly text: string }
  | { readonly kind: "followup"; readonly text: string }
  | { readonly kind: "slash"; readonly line: string };

export function decideLineAction(line: string, running: boolean): LineAction {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "ignore" };
  if (trimmed.startsWith("/")) return { kind: "slash", line: trimmed };
  return running ? { kind: "steer", text: trimmed } : { kind: "followup", text: trimmed };
}

function dialOf(options: AgentOptions): SlashDial {
  return {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
  };
}

interface MakeNextInput {
  readonly loop: AgentLoopService;
  readonly over: { readonly sessionId?: SessionId; readonly newSession?: boolean };
  readonly previousId: SessionId;
  readonly options: AgentOptions;
}

/** 建立下一会话：newSession → create；指定 id 或当前 id → resume；同会话 resume 失败
 *  （--no-session 无 archive 等）兜底 create 新会话，避免 REPL 无会话可用。
 *  工具面 restriction 重演（终审 B1 处置）：create 语义（/new 与兜底）恒注册全量快照
 *  （W2B §1.1 血缘分级名单恒可读）；resume 语义（/model、/resume）带 flag 才注册，
 *  无 flag = 显式放开（与迁移前 spread undefined 等价——不再误把放开态变受限态） */
async function makeNext(input: MakeNextInput & { readonly world: import("./build-world.ts").World; readonly args: CliArgs; readonly registered: readonly string[] }): Promise<Result<AgentHandle>> {
  const { loop, over, options, world, args, registered } = input;
  const registerCreate = (sessionId: SessionId): void => {
    world.registry.scoped(sessionId).restrict(resolveToolNames(args, registered)); // create 语义：恒全量快照
  };
  if (over.newSession === true) {
    const made = await loop.create({ agent: options }); // 缺省铸号（mintSessionId 单一来源）
    if (made.ok) registerCreate(made.value.agent.session.id);
    return made;
  }
  const resumed = await loop.resume({ id: over.sessionId ?? input.previousId, agent: options });
  if (resumed.ok) {
    // resume 语义：带 flag 才注册（无 flag = 显式放开——终审 B1 处置，与迁移前 spread undefined 等价）
    if (args.noTools || args.tools !== undefined || args.excludeTools !== undefined) {
      world.registry.scoped(resumed.value.agent.session.id).restrict(resolveToolNames(args, registered));
    }
    return resumed;
  }
  if (over.sessionId !== undefined) return resumed; // 指定 id 失败——不兜底（沿用旧契约）
  const made = await loop.create({ agent: options }); // 兜底 = create 语义恒快照（缺省铸号，mintSessionId 单一来源）
  if (made.ok) registerCreate(made.value.agent.session.id);
  return made;
}

/** 切换收尾：flush 屏障 + mailbox 重绑 + dial 更新 + 文案（reopen 复杂度纪律抽出） */
/** --schema 的括号平衡扫描：从 parts[start+1] 起收集到 JSON 闭合——返回 [json, 末索引] */
function scanSchemaJson(parts: readonly string[], start: number): { readonly json?: unknown; readonly error?: string; readonly end: number } {
  const joined: string[] = [];
  let depth = 0;
  let end = start;
  for (let k = start + 1; k < parts.length; k++) {
    const piece = parts[k];
    if (piece === undefined) continue;
    joined.push(piece);
    depth += (piece.match(/{/g) ?? []).length - (piece.match(/}/g) ?? []).length;
    end = k;
    if (depth <= 0 && joined.length > 0) break;
  }
  try {
    return { json: JSON.parse(joined.join(" ")) as unknown, end };
  } catch (error) {
    return { error: `--schema JSON 无效：${error instanceof Error ? error.message : String(error)}`, end };
  }
}

/** /workflow submit 参数解析：--verify <command> | --schema <json> | 其余为描述+任务 */
export function parseWorkflowSubmitArgs(raw: string): { ok: true; input: { description: string; prompt: string; acceptance?: { command: string }; result_schema?: unknown } } | { ok: false; reason: string } {
  let command: string | undefined;
  let schema: unknown;
  const words: string[] = [];
  const parts = raw.split(/\s+/).filter((w) => w !== "");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const next = parts[i + 1];
    if (part === "--verify" && next !== undefined) {
      command = next;
      i += 1;
      continue;
    }
    if (part === "--schema") {
      const scanned = scanSchemaJson(parts, i);
      if (scanned.error !== undefined) return { ok: false, reason: scanned.error };
      schema = scanned.json;
      i = scanned.end;
      continue;
    }
    words.push(part);
  }
  if (words.length === 0) return { ok: false, reason: "usage: /workflow submit [--verify <command>] [--schema <json>] <描述与任务>" };
  const [first, ...promptWords] = words;
  const description = first ?? "task";
  return { ok: true, input: { description, prompt: promptWords.join(" ") || description, ...(command !== undefined ? { acceptance: { command } } : {}), ...(schema !== undefined ? { result_schema: schema } : {}) } };
}

/** /workflow 命令实现（workflowView 直调——期 3 不经模型；world/handle 经 getter 取活引用） */
export function makeWorkflowCommands(live: () => { readonly world: World; readonly handle: import("@x-harness/agent-loop").AgentHandle }): import("./slash-commands.ts").WorkflowCommandDeps {
  return {
    workflowSubmit: async (args) => {
      const parsed = parseWorkflowSubmitArgs(args);
      if (!parsed.ok) return parsed.reason;
      const { world, handle } = live();
      const view = world.ctx.tryUse(workflowView);
      if (view === undefined) return "workflow 插件未装配（此构建无 /workflow 面）";
      const made = await view.submit(handle.agent.session.id, parsed.input);
      return made.ok ? made.text : made.reason;
    },
    workflowStop: async (taskId) => {
      const { world, handle } = live();
      const registry = world.ctx.use((await import("@x-harness/tools")).toolRegistry);
      const made = await registry.dispatch({ callId: `wf-stop-${String(Math.random()).slice(2, 8)}`, name: "task_stop", args: { task_id: taskId }, signal: new AbortController().signal, session: handle.agent.session.id });
      return String(made.content);
    },
    workflowRuns: async () => {
      const { world } = live();
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { resolveWorkflowRoot } = await import("@x-harness/agent-workflow");
      void world;
      const root = resolveWorkflowRoot();
      const lines: string[] = [];
      for (const rid of await readdir(root).catch(() => [] as string[])) {
        const raw = await readFile(join(root, rid, "journal.jsonl"), "utf8").catch(() => "");
        if (raw === "") continue;
        const events = raw.split("\n").filter((l) => l !== "").map((l) => { try { return JSON.parse(l) as { type: string }; } catch { return { type: "?" }; } });
        const settled = events.some((e) => e.type === "run/settled");
        lines.push(`${rid}  ${settled ? "settled" : (events[events.length - 1]?.type ?? "?")}`);
      }
      return lines.length === 0 ? "（无 run）" : lines.join("\n");
    },
  };
}

async function finalizeSwitch(deps: {
  readonly world: import("./build-world.ts").World;
  readonly handle: AgentHandle;
  readonly io: { readonly write: (text: string) => void };
  readonly quit: (code?: number) => void;
  readonly newSession: boolean;
  readonly onDial: (dial: SlashDial) => void;
}): Promise<string> {
  const { world, handle, io, quit } = deps;
  const flushed = await world.store.flush(handle.agent.session.id);
  if (!flushed.ok) {
    quit(1);
    return `fatal: switched session cannot persist: ${flushed.reason}`;
  }
  // 跨进程邮箱重绑（AGENT-DELEGATION §5.3 宿主接线）：信封路由/出站身份/状态镜像随新会话
  // 换目标——失败仅告警（跨进程收件降级为不可达，进程内子代理与对话不受影响）
  const rebound = await world.ctx.tryUse(delegationView)?.rebindMailbox(handle.agent.session.id);
  if (rebound !== undefined && !rebound.ok) io.write(`warning: mailbox rebind failed (${rebound.reason}) — cross-session messaging may misroute\n`);
  // workflow run 归属迁移（件16 期 2-A）：切会话后 workflow_submit 复活 + 悬置通知转向新会话
  const workflowRebound = await world.ctx.tryUse(workflowView)?.rebind(handle.agent.session.id);
  if (workflowRebound !== undefined && !workflowRebound.ok) io.write(`warning: workflow rebind failed (${workflowRebound.reason}) — pending runs keep the old session\n`);
  const dial = dialOf(handle.agent.options);
  deps.onDial(dial);
  if (deps.newSession) return `new session ${handle.agent.session.id} (${dial.provider ?? "?"}/${dial.model ?? "?"})`;
  return `switched to ${dial.provider ?? "?"}/${dial.model ?? "?"} (session ${handle.agent.session.id})`;
}

export async function runRepl(input: ReplInput): Promise<number> {
  const { world, io } = input;
  // 注册工具名快照：restriction 重演的基集（makeNext 单点用——F-2 处置）
  const registeredToolNames = world.registry.schemas().map((schema) => schema.name);
  let handle = input.handle;
  let dial = dialOf(handle.agent.options);
  let quitting = false;
  let compactAbort = new AbortController();
  const terminal = createReplTerminal({ stdin: io.stdin, write: io.write });
  const renderer = createStreamRenderer({ write: io.write, isTTY: io.isTTY });
  let turnChain = Promise.resolve();

  const offStream = world.ctx.on(agentAssistantStream, ({ frame }) => renderer.frame(frame));
  const offSession = world.ctx.on(sessionEvent, ({ event }) => renderer.sessionEvent(event));

  const settleTurn = async (): Promise<void> => {
    await handle.agent.whenIdle();
    if (quitting) return;
    const usage = world.meter.usageOf(handle.agent.session.id);
    if (usage !== undefined) io.write(`${formatTurnLine(usage.turns.length, usage)}\n`);
    terminal.showPrompt();
  };

  const kick = (text: string): void => {
    io.write("\n");
    try {
      handle.agent.followup(text);
    } catch {
      io.write("session is closing — input dropped\n");
      return;
    }
    turnChain = turnChain.then(() => settleTurn());
  };

  const steer = (text: string): void => {
    try {
      handle.agent.steer(text);
      io.write("(steered)\n");
    } catch {
      io.write("session is closing — input dropped\n");
    }
  };

  /** 换会话/换 dial：先 dispose 现有，再建新（flush 屏障防切进不可持久化会话）；
   *  失败兜底新建内存态防 REPL 裸奔；switching 互斥防并发 slash 双重切换 */
  let switching = false;
  const buildNextOptions = (over: { readonly dial?: SlashDial }): AgentOptions => {
    const nextDial = { ...dial, ...over.dial };
    return { ...input.baseOptions, ...nextDial, ...(input.args.systemPrompt !== undefined ? { systemPrompt: input.args.systemPrompt } : {}) };
  };
  const reopen = async (over: { readonly sessionId?: SessionId; readonly newSession?: boolean; readonly dial?: SlashDial }): Promise<string> => {
    if (switching) return "already switching";
    if (handle.agent.status === "running") return "cannot switch while the agent is running";
    if (over.sessionId === undefined && over.newSession !== true && over.dial === undefined) return "nothing to switch";
    switching = true;
    try {
      if (input.persist && over.newSession !== true) {
        io.write("note: switching resets session grants and background tasks\n");
      }
      const previousId = handle.agent.session.id;
      await handle.dispose().catch(() => {});
      const made = await makeNext({ loop: world.loop, over, previousId, options: buildNextOptions(over), world, args: input.args, registered: registeredToolNames });
      if (!made.ok) {
        quit(1);
        return `fatal: session switch failed: ${made.reason}`;
      }
      handle = made.value;
      const finalized = await finalizeSwitch({ world, handle: made.value, io, quit, newSession: over.newSession === true, onDial: (next) => { dial = next; } });
      return finalized;
    } finally {
      switching = false;
    }
  };

  const slashDeps: SlashDeps = {
    write: (line) => io.write(`${line}\n`),
    question: (prompt) => terminal.question(prompt),
    config: input.config,
    current: () => ({ dial, inMemory: !input.persist }),
    usageSummary: () => {
      const usage = world.meter.usageOf(handle.agent.session.id);
      return usage === undefined ? "tokens: none yet" : formatSessionSummary(usage);
    },
    sessionFacts: () => `session ${handle.agent.session.id} · ${String(handle.agent.session.events().length)} events · ${dial.provider ?? "?"}/${dial.model ?? "?"} · thinking ${dial.thinking ?? "off"}`,
    reopen,
    listMainSessions: async () => (world.archive === undefined ? [] : mainSessions(await world.archive.listHeaders())),
    compact: async (instructions) => {
      if (handle.agent.status === "running") return "cannot compact while the agent is running";
      // 统一走 compactionRunner（docs/COMPACTION.md 手动面）：结构化 checkpoint 摘要 +
      // 文件账本 + keepRecent 尾保留；dial 参数不入——摘要面是装配期快照（默认档）
      // 入口条件重铸：Ctrl+C（idle 单击/quit）abort 的永远是「在飞压缩持有的」当前
      // 控制器——在飞可取消；下一次 /compact 检测到已 abort 则重铸，不被毒化
      if (compactAbort.signal.aborted) compactAbort = new AbortController();
      const result = await world.ctx.use(compactionRunner).compact({
        session: handle.agent.session.id,
        ...(instructions !== undefined && instructions.trim() !== "" ? { customInstructions: instructions } : {}),
        signal: compactAbort.signal,
      });
      if (!result.ok) return compactFailureText(result.reason);
      return `compacted [${String(result.replacedNodes)} nodes · ~${String(result.summaryTokens)} tokens]`;
    },
    exportTo: async (path) => {
      const exported = await exportSession({ store: world.store, sessionRoot: input.sessionRoot, session: handle.agent.session, persist: input.persist, target: path });
      return exported.ok ? `exported to ${exported.value.path}` : exported.reason;
    },
    // /workflow 命令面（件16 期 3：不经模型——workflowView 直调）
    workflow: makeWorkflowCommands(() => ({ world, handle })),
  };

  let quitReason: (code: number) => void = () => {};
  const quit = (code = 0): void => {
    if (quitting) return;
    quitting = true;
    compactAbort.abort();
    try {
      handle.agent.cancel("quitting"); // 在飞 turn 立即收尾（whenIdle 才能到达），否则退出挂到流自然结束
    } catch {
      // 已在收尾路径——忽略
    }
    terminal.close();
    quitReason(code);
  };

  // Ctrl+C 状态机（docs/CLI.md §2.3）：ask 挂起 → 强制收束提问（deny）+ cancel turn；
  // running → cancel；idle → 500ms 双击退出（单击顺带 abort 在飞 compact）。
  // readline 事件与进程 SIGINT 两来源共用（幂等）
  let lastInterrupt = 0;
  const onInterrupt = (): void => {
    if (quitting) return;
    if (terminal.cancelPendingQuestion()) {
      try {
        handle.agent.cancel("interrupted");
      } catch {
        // 已在收尾路径——忽略
      }
      return;
    }
    if (handle.agent.status === "running") {
      try {
        handle.agent.cancel("interrupted");
      } catch {
        // 已在收尾路径——忽略
      }
      return;
    }
    compactAbort.abort();
    const now = Date.now();
    if (now - lastInterrupt < DOUBLE_PRESS_MS) quit();
    else io.write("(press Ctrl+C again to quit)\n");
    lastInterrupt = now;
  };
  terminal.onInterrupt(onInterrupt);
  terminal.onQuit(quit);

  if (input.io.onSignal !== undefined) {
    input.io.onSignal("SIGINT", onInterrupt);
    input.io.onSignal("SIGTERM", () => quit(143));
    input.io.onSignal("SIGHUP", () => quit(129));
  }

  terminal.onLine((line) => {
    if (quitting) return;
    const action = decideLineAction(line, handle.agent.status === "running");
    if (action.kind === "ignore") {
      terminal.showPrompt();
      return;
    }
    if (action.kind === "steer") {
      steer(action.text);
      return;
    }
    if (action.kind === "followup") {
      kick(action.text);
      return;
    }
    if (action.kind === "slash") {
      if ((handle.agent.status === "running" || switching) && action.line !== "/quit") {
        io.write("agent is busy — /quit or Ctrl+C to cancel first\n");
        return;
      }
      // 迟到/异常输入捕获降级（/export 目标不可写、compact abort 等），不炸 REPL
      void runSlashCommand(action.line, slashDeps).then(
        (outcome) => {
          if (outcome === "quit") quit();
          else if (!quitting) terminal.showPrompt();
        },
        (error: unknown) => {
          io.write(`command failed: ${error instanceof Error ? error.message : "internal error"}\n`);
          if (!quitting) terminal.showPrompt();
        },
      );
    }
  });

  io.write(`x-harness v${pkg.version} — session ${handle.agent.session.id} (${dial.provider ?? "?"}/${dial.model ?? "?"})\n`);
  io.write("type /help for commands, /quit to exit\n");
  terminal.showPrompt();
  input.wireAsk?.((prompt) => terminal.question(prompt));
  input.wireQuit?.(quit);
  for (const prompt of input.initialPrompts ?? []) kick(prompt);

  const exited = new Promise<number>((resolve) => {
    quitReason = resolve;
  });
  const code = await exited;
  offStream();
  offSession();
  await turnChain.catch(() => {});
  await handle.dispose().catch(() => {});
  return code;
}

/** 压缩 skip 理由 → REPL 文案（docs/COMPACTION.md 跳过词表闭射） */
function compactFailureText(reason: import("@x-harness/compaction").CompactionSkipReason): string {
  switch (reason) {
    case "no-cut-point":
      return "nothing to compact";
    case "summarizer-unconfigured":
      return "compact failed: no summarizer model";
    case "session-unknown":
      return "compact failed: session closed";
    case "aborted":
      return "cancelled";
    default:
      return `compact failed: ${reason}`;
  }
}
