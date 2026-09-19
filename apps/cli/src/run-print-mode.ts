// -p 非交互执行器（docs/CLI.md §2.4）：text 模式 stdout 仅最终 assistant 文本、进度走
// stderr；json 模式 stdout JSONL 事件流（session/stream/tool/usage/error/done，done 恰末行）。
// EPIPE：stdout 写失败即停写并按失败收尾（下游关管道），不崩进程、走清理路径。

import type { AgentHandle } from "@x-harness/agent-loop";
import { agentAssistantStream, agentError } from "@x-harness/agent-loop";
import type { AssistantStreamFrame } from "@x-harness/agent-loop";
import type { Context } from "@x-harness/core";
import type { SessionEvent, SessionEventType } from "@x-harness/session";
import { sessionEvent } from "@x-harness/session";
import type { TokenMeterService } from "@x-harness/token-meter";
import { createStreamRenderer } from "./render-stream.ts";
import type { StreamRenderer } from "./render-stream.ts";
import { formatTurnLine } from "./format-usage.ts";
import type { CliArgs } from "./parse-cli-args.ts";

export interface PrintStreams {
  /** stdout 写面（text：仅最终文本；json：JSONL 行） */
  readonly out: (text: string) => void;
  /** stderr 进度写面 */
  readonly err: (text: string) => void;
}

export interface PrintModeInput {
  readonly ctx: Context;
  readonly handle: AgentHandle;
  readonly meter: TokenMeterService;
  readonly args: CliArgs;
  /** 首条提示（stdin+@file+首位置参数拼接产物）；与 remaining 并列顺序执行 */
  readonly initialMessage: string | undefined;
  /** 首条之后的位置参数消息 */
  readonly remainingMessages: readonly string[];
  readonly streams: PrintStreams;
  /** stderr 是否 TTY（text 进度的 thinking dim 仅 TTY 下打 ANSI） */
  readonly progressTTY: boolean;
}

/** 运行态：一次 print 执行的共享面（out 已含 EPIPE 停写守卫） */
interface PrintRun {
  readonly input: PrintModeInput;
  readonly out: (text: string) => void;
  readonly json: boolean;
  readonly progress: StreamRenderer;
  readonly broken: () => boolean;
}

/** 观察者面：流帧/工具事件/错误 → json 行或 stderr 进度 */
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
  const toolNames = new Map<string, string>(); // callId → 工具名（tool/result 不带 name）

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

/** 最后一条 assistant 消息（最终文本 + 停止原因） */
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

/** 回合循环：逐条 followup + whenIdle + 每回合用量行；返回完成的回合数 */
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

/** 收尾：退出码判定 + 终态输出（json：done 恰末行；text：最终文本到 stdout、错误到 stderr） */
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
