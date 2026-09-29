import type { AgentHandle } from "@x-harness/agent-loop";
import { agentAssistantStream, agentError } from "@x-harness/agent-loop";
import type { AssistantStreamFrame } from "@x-harness/agent-loop";
import type { Context } from "@x-harness/core";
import { permissionDecided } from "@x-harness/permission";
import type { SessionEvent, SessionEventType } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import type { TokenMeterService } from "@x-harness/token-meter";
import { createStreamRenderer } from "./render-stream.ts";
import type { StreamRenderer } from "./render-stream.ts";
import { formatTurnLine } from "./format-usage.ts";
import type { CliArgs } from "./parse-cli-args.ts";

export interface PrintStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface PrintModeInput {
  readonly ctx: Context;
  readonly handle: AgentHandle;
  readonly meter: TokenMeterService;
  readonly args: CliArgs;
  readonly initialMessage: string | undefined;
  readonly remainingMessages: readonly string[];
  readonly streams: PrintStreams;
  readonly progressTTY: boolean;
}

interface PrintRun {
  readonly input: PrintModeInput;
  readonly out: (text: string) => void;
  readonly json: boolean;
  readonly progress: StreamRenderer;
  readonly broken: () => boolean;
}

interface Observers {
  readonly offs: readonly (() => void)[];
  readonly errorMessage: () => string | undefined;
}

function jsonLine(type: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ type, ...data })}\n`;
}

function wireObservers(run: PrintRun): Observers {
  const { input, out, json, progress } = run;
  let errorMessage: string | undefined;
  const toolNames = new Map<string, string>();

  const onStream = ({ frame }: { frame: AssistantStreamFrame }): void => {
    if (json) {
      if (frame.phase === "chunk") out(jsonLine("stream", { phase: "chunk", kind: frame.kind, text: frame.text }));
      else out(jsonLine("stream", { phase: frame.phase, ...(frame.phase === "end" ? { kind: frame.kind } : {}) }));
      return;
    }
    progress.frame(frame);
  };

  const onSessionEvent = ({ event }: { event: SessionEvent<SessionEventType> }): void => {
    if (event.type === "tool/call") {
      toolNames.set(event.data.callId, event.data.name);
      if (json) out(jsonLine("tool", { phase: "call", name: event.data.name, callId: event.data.callId, arguments: event.data.arguments }));
      else progress.sessionEvent(event);
      return;
    }
    if (event.type === "tool/result") {
      const name = toolNames.get(event.data.callId) ?? event.data.callId;
      if (json) out(jsonLine("tool", { phase: "result", name, callId: event.data.callId, isError: event.data.isError === true, content: event.data.content }));
      else progress.sessionEvent(event);
    }
  };

  const offs = [
    input.ctx.on(agentAssistantStream, onStream),
    input.ctx.on(sessionEvent, onSessionEvent),
    input.ctx.on(permissionDecided, (audit) => {
      if (json) out(jsonLine("permission", { tool: audit.tool, verdict: audit.verdict, reason: audit.reason }));
    }),
    input.ctx.on(agentError, ({ message }) => {
      errorMessage = message;
      if (json) out(jsonLine("error", { message }));
    }),
  ];
  return { offs, errorMessage: () => errorMessage };
}

interface TurnOutcome {
  readonly text: string;
  readonly stopReason: string | undefined;
}

function lastAssistant(events: readonly SessionEvent<SessionEventType>[]): TurnOutcome | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === "assistant/message") {
      return {
        text: event.data.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
        stopReason: event.data.stopReason,
      };
    }
  }
  return undefined;
}

function emitUsage(run: PrintRun, turnIndex: number): void {
  const usage = run.input.meter.usageOf(run.input.handle.agent.session.id);
  if (run.json) {
    run.out(jsonLine("usage", usage === undefined ? { turn: turnIndex } : { turn: turnIndex, ...usage }));
    return;
  }
  if (usage !== undefined) run.input.streams.err(`${formatTurnLine(turnIndex, usage)}\n`);
}

async function runPrompts(run: PrintRun, observers: Observers): Promise<number> {
  const { input, out, json, broken } = run;
  const prompts = [...(input.initialMessage !== undefined ? [input.initialMessage] : []), ...input.remainingMessages];
  if (json) out(jsonLine("session", { ...input.handle.agent.session.header }));
  let turnIndex = 0;
  for (const prompt of prompts) {
    if (broken()) break;
    input.handle.agent.followup(prompt);
    await input.handle.agent.whenIdle();
    turnIndex += 1;
    emitUsage(run, turnIndex);
  }
  for (const off of observers.offs) off();
  return turnIndex;
}

function emitOutcome(run: PrintRun, errorMessage: string | undefined): number {
  const { input, out, json, broken } = run;
  const last = lastAssistant(input.handle.agent.session.events());
  const failed = errorMessage !== undefined || last?.stopReason === "error" || last?.stopReason === "aborted";
  let exitCode = 0;
  if (broken() || failed) exitCode = 1;
  if (json) {
    out(jsonLine("done", { exit: exitCode }));
    return exitCode;
  }
  if (broken()) return exitCode;
  if (last !== undefined && last.text.length > 0) out(`${last.text}\n`);
  if (errorMessage !== undefined) input.streams.err(`error: ${errorMessage}\n`);
  else if (failed && last !== undefined) input.streams.err(`error: turn stopped (${last.stopReason ?? "unknown"})\n`);
  return exitCode;
}

export async function runPrintMode(input: PrintModeInput): Promise<number> {
  const { streams } = input;
  const json = input.args.mode === "json";
  let broken = false;

  const out = (text: string): void => {
    if (broken) return;
    try {
      streams.out(text);
    } catch (error) {
      if ((error as { code?: string }).code === "EPIPE") broken = true;
      else throw error;
    }
  };
  const progress = createStreamRenderer({ write: (text) => streams.err(text), isTTY: input.progressTTY });
  const run: PrintRun = { input, out, json, progress, broken: () => broken };
  const observers = wireObservers(run);
  await runPrompts(run, observers);
  return emitOutcome(run, observers.errorMessage());
}
