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
import { planControl } from "@x-harness/tool-plan";
import type { SessionId } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import pkg from "../package.json";

const DOUBLE_PRESS_MS = 500;

export interface ReplIO {
  readonly write: (text: string) => void;
  readonly stdin: NodeJS.ReadableStream;
  readonly isTTY: boolean;
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
  readonly initialPrompts?: readonly string[];
  readonly wireAsk?: (ask: (prompt: string) => Promise<string | undefined>) => void;
  readonly wireQuit?: (quit: (code: number) => void) => void;
}

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

async function makeNext(input: MakeNextInput & { readonly world: import("./build-world.ts").World; readonly args: CliArgs; readonly registered: readonly string[] }): Promise<Result<AgentHandle>> {
  const { loop, over, options, world, args, registered } = input;
  const registerCreate = (sessionId: SessionId): void => {
    world.registry.scoped(sessionId).restrict(resolveToolNames(args, registered));
  };
  if (over.newSession === true) {
    const made = await loop.create({ agent: options });
    if (made.ok) registerCreate(made.value.agent.session.id);
    return made;
  }
  const resumed = await loop.resume({ id: over.sessionId ?? input.previousId, agent: options });
  if (resumed.ok) {
    if (args.noTools || args.tools !== undefined || args.excludeTools !== undefined) {
      world.registry.scoped(resumed.value.agent.session.id).restrict(resolveToolNames(args, registered));
    }
    return resumed;
  }
  if (over.sessionId !== undefined) return resumed;
  const made = await loop.create({ agent: options });
  if (made.ok) registerCreate(made.value.agent.session.id);
  return made;
}

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

export function makePermissionCommands(live: () => { readonly world: World; readonly handle: import("@x-harness/agent-loop").AgentHandle }): import("./slash-commands.ts").PermissionCommandDeps {
  return {
    planToggle: () => {
      const { world, handle } = live();
      const control = world.ctx.tryUse(planControl);
      if (control === undefined) return "plan 服务未装配（此构建无 /plan 面）";
      const session = handle.agent.session.id;
      if (control.isPlan()) {
        const target = control.exit(session);
        return `plan mode OFF — permission mode: ${target}`;
      }
      control.enter(session);
      return "plan mode ON — writes denied; the agent researches and submits a plan (plan_submit)";
    },
  };
}

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
  const rebound = await world.ctx.tryUse(delegationView)?.rebindMailbox(handle.agent.session.id);
  if (rebound !== undefined && !rebound.ok) io.write(`warning: mailbox rebind failed (${rebound.reason}) — cross-session messaging may misroute\n`);
  const workflowRebound = await world.ctx.tryUse(workflowView)?.rebind(handle.agent.session.id);
  if (workflowRebound !== undefined && !workflowRebound.ok) io.write(`warning: workflow rebind failed (${workflowRebound.reason}) — pending runs keep the old session\n`);
  const dial = dialOf(handle.agent.options);
  deps.onDial(dial);
  if (deps.newSession) return `new session ${handle.agent.session.id} (${dial.provider ?? "?"}/${dial.model ?? "?"})`;
  return `switched to ${dial.provider ?? "?"}/${dial.model ?? "?"} (session ${handle.agent.session.id})`;
}

export async function runRepl(input: ReplInput): Promise<number> {
  const { world, io } = input;
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
    workflow: makeWorkflowCommands(() => ({ world, handle })),
    permission: makePermissionCommands(() => ({ world, handle })),
  };

  let quitReason: (code: number) => void = () => {};
  const quit = (code = 0): void => {
    if (quitting) return;
    quitting = true;
    compactAbort.abort();
    try {
      handle.agent.cancel("quitting");
    } catch {
    }
    terminal.close();
    quitReason(code);
  };

  let lastInterrupt = 0;
  const onInterrupt = (): void => {
    if (quitting) return;
    if (terminal.cancelPendingQuestion()) {
      try {
        handle.agent.cancel("interrupted");
      } catch {
      }
      return;
    }
    if (handle.agent.status === "running") {
      try {
        handle.agent.cancel("interrupted");
      } catch {
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
