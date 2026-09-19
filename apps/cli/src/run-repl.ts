// REPL 主循环（docs/CLI.md §2.3/§2.7）：行分派（steer/followup/slash）、Ctrl+C 状态机
// （running=cancel；ask 挂起=强制关闭提问→deny+cancel；idle 双击 500ms=退出）、
// 退出清理（当前 handle dispose 后返回，ctx 归 main）。迟到输入一律捕获降级不炸。

import type { AgentHandle, AgentLoopService, AgentOptions } from "@x-harness/agent-loop";
import { agentAssistantStream } from "@x-harness/agent-loop";
import type { Result } from "@x-harness/core";
import type { CliArgs } from "./parse-cli-args.ts";
import { formatSessionSummary, formatTurnLine } from "./format-usage.ts";
import { newSessionId } from "./new-session-id.ts";
import type { ProvidersConfig } from "./providers-file.ts";
import { mainSessions } from "./resolve-session.ts";
import { createReplTerminal } from "./repl-terminal.ts";
import { compactSession } from "./compact-session.ts";
import { exportSession } from "./export-session.ts";
import { createStreamRenderer } from "./render-stream.ts";
import { runSlashCommand } from "./slash-commands.ts";
import type { SlashDeps, SlashDial } from "./slash-commands.ts";
import type { World } from "./build-world.ts";
import type { SessionId } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import pkg from "../package.json";

const DOUBLE_PRESS_MS = 500;

export interface ReplIO {
  readonly write: (text: string) => void;
  readonly stdin: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  /** 信号面注入（生产 = process.on）；缺席 = 不接信号（进程默认语义，测试安全） */
  readonly onSignal?: (kind: "SIGTERM" | "SIGHUP", callback: () => void) => void;
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
  /** broker 提问面接线：REPL 终端就绪后回传 question（Ctrl+C 强制关闭 → undefined → deny） */
  readonly wireAsk?: (ask: (prompt: string) => Promise<string | undefined>) => void;
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
 *  （--no-session 无 archive 等）兜底 create 新会话，避免 REPL 无会话可用 */
async function makeNext(input: MakeNextInput): Promise<Result<AgentHandle>> {
  const { loop, over, options } = input;
  if (over.newSession === true) {
    return loop.create({ session: { id: newSessionId() }, agent: options });
  }
  const resumed = await loop.resume({ id: over.sessionId ?? input.previousId, agent: options });
  if (resumed.ok || over.sessionId !== undefined) return resumed;
  return loop.create({ session: { id: newSessionId() }, agent: options });
}

export async function runRepl(input: ReplInput): Promise<number> {
  const { world, io } = input;
  let handle = input.handle;
  let dial = dialOf(handle.agent.options);
  let quitting = false;
  let turnCount = 0;
  const compactAbort = new AbortController();
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
    turnCount += 1;
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

  /** 换会话/换 dial：先 dispose 现有，再建新；失败兜底新建内存态防 REPL 裸奔 */
  const reopen = async (over: { readonly sessionId?: SessionId; readonly newSession?: boolean; readonly dial?: SlashDial }): Promise<string> => {
    if (handle.agent.status === "running") return "cannot switch while the agent is running";
    if (over.sessionId === undefined && over.newSession !== true && over.dial === undefined) return "nothing to switch";
    if (input.persist && over.newSession !== true) {
      io.write("note: switching resets session grants and background tasks\n");
    }
    const nextDial = { ...dial, ...over.dial };
    const nextOptions: AgentOptions = { ...input.baseOptions, ...nextDial, ...(input.args.systemPrompt !== undefined ? { systemPrompt: input.args.systemPrompt } : {}) };
    const previousId = handle.agent.session.id;
    await handle.dispose();
    const made = await makeNext({ loop: world.loop, over, previousId, options: nextOptions });
    if (!made.ok) {
      quit(1);
      return `fatal: session switch failed: ${made.reason}`;
    }
    handle = made.value;
    dial = dialOf(handle.agent.options);
    if (over.newSession === true) {
      return `new session ${handle.agent.session.id} (${dial.provider ?? "?"}/${dial.model ?? "?"})`;
    }
    return `switched to ${dial.provider ?? "?"}/${dial.model ?? "?"} (session ${handle.agent.session.id})`;
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
      const outcome = await compactSession({ ctx: world.ctx, session: handle.agent.session, dial, instructions, signal: compactAbort.signal });
      if (outcome.kind === "noop") return "nothing to compact";
      if (outcome.kind === "failed") return `compact failed: ${outcome.reason}`;
      return `compacted [${String(outcome.fromSeq)}..${String(outcome.toSeq)}]`;
    },
    exportTo: async (path) => {
      const exported = await exportSession({ store: world.store, sessionRoot: input.sessionRoot, session: handle.agent.session, persist: input.persist, target: path });
      return exported.ok ? `exported to ${exported.value.path}` : exported.reason;
    },
  };

  let quitReason: (code: number) => void = () => {};
  const quit = (code = 0): void => {
    if (quitting) return;
    quitting = true;
    compactAbort.abort();
    terminal.close();
    quitReason(code);
  };

  if (input.io.onSignal !== undefined) {
    input.io.onSignal("SIGTERM", () => quit(143));
    input.io.onSignal("SIGHUP", () => quit(129));
  }

  // Ctrl+C 状态机（docs/CLI.md §2.3）：ask 挂起 → 强制关闭提问（broker deny）；running → cancel；
  // idle → 500ms 双击退出
  let lastInterrupt = 0;
  terminal.onInterrupt(() => {
    if (quitting) return;
    if (handle.agent.status === "running") {
      try {
        handle.agent.cancel("interrupted");
      } catch {
        // 已在收尾路径——忽略
      }
      return;
    }
    const now = Date.now();
    if (now - lastInterrupt < DOUBLE_PRESS_MS) quit();
    else io.write("(press Ctrl+C again to quit)\n");
    lastInterrupt = now;
  });
  terminal.onQuit(quit);

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
      if (handle.agent.status === "running" && action.line !== "/quit") {
        io.write("agent is running — /quit or Ctrl+C to cancel first\n");
        return;
      }
      void runSlashCommand(action.line, slashDeps).then((outcome) => {
        if (outcome === "quit") quit();
        else if (!quitting) terminal.showPrompt();
      });
    }
  });

  io.write(`x-harness v${pkg.version} — session ${handle.agent.session.id} (${dial.provider ?? "?"}/${dial.model ?? "?"})\n`);
  io.write("type /help for commands, /quit to exit\n");
  terminal.showPrompt();
  input.wireAsk?.((prompt) => terminal.question(prompt));

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
