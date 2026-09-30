import type { Session, SessionId } from "@x-harness/session";
import { hubError, errorOfCause } from "../shared/errors.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import { normalizeImages } from "../shared/images.ts";
import type { WireImage } from "../shared/images.ts";
import type { ImageBlock } from "@x-harness/session";
import { parseCommand } from "@x-harness/commands";
import { imagesUnsupported } from "./meta-state.ts";
import { threadGate } from "./thread-gate.ts";
import { currentDialOf } from "./meta-state.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import type { DialFact } from "../shared/meta-fold.ts";
import type { CommandOutcome } from "./outcome.ts";

export interface SendCommandState {
  session: Session | undefined;
  currentThreadId: string | undefined;
  catalog: WorkerCatalog;
  dial: DialFact;
  commands: { find(name: string): unknown; execute(session: Session, line: string, signal: AbortSignal): Promise<{ result: { kind: string; text: string; data?: unknown } } | undefined> } | undefined;
  agent: import("@x-harness/agent-loop").Agent | undefined;
  streaming(): boolean;
  pendingSends(): number;
  bash: { abortAdmissions(): void; abortRunning(id: string | undefined): void };
  broker: { denyAll(): void };
  inflight: { abortAll(): Promise<void> };
  delegation: { stopAll(id: SessionId, cause: string): Promise<void> } | undefined;
  settle(sendId: string | undefined): void;
}

function imageOptions(images: readonly WireImage[] | undefined): { images: readonly ImageBlock[] } | undefined {
  return images === undefined ? undefined : { images: [...images] };
}

function noThread(command: string): CommandOutcome {
  return { command, error: hubError("unknown_thread", "Unknown threadId") };
}

function imagesGate(state: SendCommandState, images: readonly WireImage[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  const session = state.session;
  const dial = session !== undefined ? currentDialOf(session.events(), state.dial) : state.dial;
  return imagesUnsupported(state.catalog, dial);
}

export async function prompt(state: SendCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const gate = threadGate({ session: state.session, currentThreadId: state.currentThreadId }, { threadId: input.threadId, command: "prompt" });
  if (!gate.ok) return gate.outcome;
  const message = typeof input.message === "string" ? input.message : "";
  if (message === "") return { command: "prompt", error: hubError("invalid_input", "prompt message required") };
  const parsedImages = normalizeImages(input.images);
  if (!parsedImages.ok) return { command: "prompt", error: hubError(parsedImages.code, parsedImages.reason) };
  const imagesDenied = imagesGate(state, parsedImages.images);
  if (imagesDenied !== undefined) return { command: "prompt", error: hubError("capability_images", imagesDenied) };
  const dispatched = await dispatchCommand(state, input.id, { command: "prompt", line: message, imagesPresent: input.images !== undefined });
  if (dispatched !== undefined) return dispatched;
  if (state.pendingSends() > 0 || state.streaming()) {
    return promptStreamingBranch({ state, behavior: input.streamingBehavior, requestId: requestId2(input.id), message, images: parsedImages.images });
  }
  const agent = state.agent;
  if (agent === undefined) return noThread("prompt");
  try {
    agent.followup(message, imageOptions(parsedImages.images));
  } catch (error) {
    return { command: "prompt", error: errorOfCause(error) };
  }
  state.settle(requestId2(input.id));
  return { command: "prompt" };
}

async function dispatchCommand(state: SendCommandState, requestId: unknown, spec: { command: string; line: string; imagesPresent: boolean }): Promise<CommandOutcome | undefined> {
  const registry = state.commands;
  if (registry === undefined || state.session === undefined) return undefined;
  const parsed = parseCommand(spec.line);
  if (spec.imagesPresent && parsed !== undefined && registry.find(parsed.name) !== undefined) {
    return { command: spec.command, error: hubError("invalid_input", "invalid images: compact does not accept images") };
  }
  try {
    const execution = await registry.execute(state.session, spec.line, new AbortController().signal);
    if (execution === undefined) return undefined;
    if (execution.result.kind === "error") {
      return { command: spec.command, error: hubError("compact_rejected", execution.result.text) };
    }
    return { command: spec.command, data: execution.result.data };
  } catch (error) {
    return { command: spec.command, error: errorOfCause(error) };
  }
}

function promptStreamingBranch(input: { state: SendCommandState; behavior: unknown; requestId: string | undefined; message: string; images: readonly WireImage[] | undefined }): CommandOutcome {
  const { state, behavior, requestId, message } = input;
  if (behavior !== "steer" && behavior !== "followUp") {
    return { command: "prompt", error: hubError("streaming_window", "streamingBehavior required while streaming") };
  }
  const agent = state.agent;
  if (agent === undefined) return noThread("prompt");
  try {
    if (behavior === "steer") agent.steer(message, imageOptions(input.images));
    else agent.followup(message, imageOptions(input.images));
  } catch (error) {
    return { command: "prompt", error: errorOfCause(error) };
  }
  state.settle(requestId);
  return { command: "prompt" };
}
function requestId2(requestId: unknown): string | undefined {
  return typeof requestId === "string" ? requestId : undefined;
}

export async function steer(state: SendCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const gate = threadGate({ session: state.session, currentThreadId: state.currentThreadId }, { threadId: input.threadId, command: "steer" });
  if (!gate.ok) return gate.outcome;
  const parsedImages = normalizeImages(input.images);
  if (!parsedImages.ok) return { command: "steer", error: hubError(parsedImages.code, parsedImages.reason) };
  const imagesDenied = imagesGate(state, parsedImages.images);
  if (imagesDenied !== undefined) return { command: "steer", error: hubError("capability_images", imagesDenied) };
  const agent = state.agent;
  if (agent === undefined) return noThread("steer");
  try {
    agent.steer(typeof input.message === "string" ? input.message : "", imageOptions(parsedImages.images));
  } catch (error) {
    return { command: "steer", error: errorOfCause(error) };
  }
  state.settle(requestId2(input.id));
  return { command: "steer" };
}

export async function followUp(state: SendCommandState, input: Record<string, unknown>): Promise<CommandOutcome> {
  const gate = threadGate({ session: state.session, currentThreadId: state.currentThreadId }, { threadId: input.threadId, command: "follow_up" });
  if (!gate.ok) return gate.outcome;
  const parsedImages = normalizeImages(input.images);
  if (!parsedImages.ok) return { command: "follow_up", error: hubError(parsedImages.code, parsedImages.reason) };
  const imagesDenied = imagesGate(state, parsedImages.images);
  if (imagesDenied !== undefined) return { command: "follow_up", error: hubError("capability_images", imagesDenied) };
  const agent = state.agent;
  if (agent === undefined) return noThread("follow_up");
  try {
    agent.followup(typeof input.message === "string" ? input.message : "", imageOptions(parsedImages.images));
  } catch (error) {
    return { command: "follow_up", error: errorOfCause(error) };
  }
  state.settle(requestId2(input.id));
  return { command: "follow_up" };
}

export async function abort(state: SendCommandState, input: Record<string, unknown> = {}): Promise<CommandOutcome> {
  const gate = threadGate({ session: state.session, currentThreadId: state.currentThreadId }, { threadId: input.threadId, command: "abort" });
  if (!gate.ok) return gate.outcome;
  const session = state.session;
  if (session === undefined) return noThread("abort");
  state.bash.abortAdmissions();
  state.bash.abortRunning(undefined);
  state.broker.denyAll();
  await state.inflight.abortAll();
  if (state.delegation !== undefined) {
    await state.delegation.stopAll(session.id, "client-abort");
  }
  state.agent?.cancel("client-abort");
  return { command: "abort" };
}

export function bashOutcomeError(reason: string): HubErrorShape {
  if (reason === "permission denied" || reason === "aborted before execution started") return hubError("bash_denied", reason);
  if (reason === "too many concurrent direct bash executions (limit reached)") return hubError("thread_limit", reason);
  if (reason === "concurrent direct bash requires a command id" || reason === "invalid command: required" || reason.startsWith("invalid timeoutMs:")) {
    return hubError("invalid_input", reason);
  }
  if (reason === "bash command id is already in use") return hubError("state_conflict", reason);
  return hubError("internal", reason);
}
