import type { ImageBlock, Session, SessionId } from "@x-harness/session";
import type { AgentHandle } from "@x-harness/agent-loop";
import { foldInbox } from "@x-harness/agent-loop";
import type { World } from "@x-harness/harness";
import type { ThinkingLevel } from "@x-harness/llm";
import type { PermissionModeService } from "@x-harness/permission";
import { hubError, errorOfCause } from "../shared/errors.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import type { DelegationView } from "@x-harness/agent-delegation";
import { responseFrame } from "../protocol/frames.ts";
import { createWorkflowHandlers } from "./workflow-commands.ts";
import { findQueueEntryTarget, foldQueue } from "../shared/inbox-fold.ts";
import { parseCommand } from "@x-harness/commands";
import { normalizeImages } from "../shared/images.ts";
import type { WireImage } from "../shared/images.ts";
import { catalogEntryOf, catalogModelIds } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import type { DialFact } from "../shared/meta-fold.ts";
import type { ScriptAdapter } from "../shared/script-adapter.ts";
import { currentDialOf, currentThinkingOf, imagesUnsupported, thinkingUnsupported, META_KEY_DIAL } from "./meta-state.ts";
import type { DialogBroker } from "./dialogs.ts";
import type { BashExec } from "./bash-exec.ts";
import type { EventBridge } from "./event-bridge.ts";
import type { InflightRegistry, InflightState } from "./inflight.ts";
import { doFork, registerThreadCommands, serializedLifecycle } from "./thread-commands.ts";
import { registerReadCommands } from "./worker-read-commands.ts";
import { registerMetaCommands } from "./worker-meta-commands.ts";
import { handleHotInstall, handleHotUninstall } from "./plugins-hot.ts";
import { registerBashCommands } from "./bash-commands.ts";


export interface WorkerState {
  handle: AgentHandle | undefined;
  world: World | undefined;
  catalog: WorkerCatalog;
  dial: DialFact;
  thinking: ThinkingLevel | undefined;
  permissionService: PermissionModeService | undefined;
  commands: import("@x-harness/commands").CommandRegistry | undefined;
  delegation: DelegationView | undefined;
  threadId: string;
  sessionPath: string;
  cwd: string;
  trusted: boolean;
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  scriptAdapter: ScriptAdapter | undefined;
}

export interface WorkerRuntime {
  state: WorkerState;
  emitLine: (line: string) => void;
  agentDir: string;
  sessionsRoot: string;
  broker: DialogBroker;
  bash: BashExec;
  inflight: InflightRegistry;
  inflightState: InflightState;
  bridge: EventBridge;
  triggerShutdown: () => void;
  env: Record<string, string | undefined>;
  pendingSends: number;
  thinkingFallback?: { level: ThinkingLevel; source: "project" | "user" } | undefined;
  permissionModeSource?: "project" | "user" | "default" | undefined;
  proposals?: import("../shared/plugin-proposals.ts").PluginProposalStore;
}

export type CommandInput = { id?: string; [key: string]: unknown };
export type Handler = (input: CommandInput) => Promise<void>;

export interface ResponseTarget {
  id: string | undefined;
  command: string;
  data?: unknown;
  error?: HubErrorShape;
}

export function respond(rt: WorkerRuntime, target: ResponseTarget): void {
  rt.emitLine(
    responseFrame({
      ...(target.id !== undefined ? { id: target.id } : {}),
      command: target.command,
      success: target.error === undefined,
      ...(target.data !== undefined ? { data: target.data } : {}),
      ...(target.error !== undefined ? { error: target.error } : {}),
    }),
  );
}

export function sessionOf(rt: WorkerRuntime): Session | undefined {
  return rt.state.handle?.agent.session;
}

export function requireThread(rt: WorkerRuntime, input: { id?: string; threadId?: unknown; command?: string }): Session | undefined {
  const session = sessionOf(rt);
  if (session === undefined || rt.state.threadId === "") {
    respond(rt, { id: input.id, command: input.command ?? "", error: hubError("unknown_thread", "Unknown threadId") });
    return undefined;
  }
  if (input.threadId !== undefined && input.threadId !== rt.state.threadId) {
    respond(rt, { id: input.id, command: input.command ?? "", error: hubError("thread_superseded", "Unknown threadId") });
    return undefined;
  }
  return session;
}

export function wrapSyncHandler(fn: (input: CommandInput) => void): Handler {
  return (input) => {
    try {
      fn(input);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  };
}

function parseImages(value: unknown): { ok: true; images: WireImage[] | undefined } | { ok: false; code: "invalid_input" | "images_too_many"; reason: string } {
  return normalizeImages(value);
}

function imagesGate(rt: WorkerRuntime, images: WireImage[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  const session = rt.state.handle?.agent.session;
  const dial = session !== undefined ? currentDialOf(session.events(), rt.state.dial) : rt.state.dial;
  return imagesUnsupported(rt.state.catalog, dial);
}

function imageOptions(images: WireImage[] | undefined): { images: readonly ImageBlock[] } | undefined {
  return images === undefined ? undefined : { images: [...images] };
}

function delegationError(reason: string): HubErrorShape {
  if (reason.startsWith("invalid-args:") || reason.startsWith("not-found:") || reason.startsWith("not-owner:")) return hubError("invalid_input", reason);
  if (reason.startsWith("not-live:")) return hubError("thread_not_live", reason);
  if (reason.startsWith("busy:")) return hubError("thread_limit", reason);
  return hubError("internal", reason);
}

export function settleAfter(rt: WorkerRuntime, id: string | undefined): boolean {
  if (id === undefined) return false;
  const handle = rt.state.handle;
  if (handle === undefined) return false;
  const threadIdAtKick = rt.state.threadId;
  const marker = handle.agent.session.events().length;
  rt.pendingSends += 1;
  void handle.agent
    .whenIdle()
    .then(() => {
      rt.pendingSends = Math.max(0, rt.pendingSends - 1);
      const events = handle.agent.session.events();
      let ok = true;
      let reason: string | undefined;
      for (let i = marker; i < events.length; i++) {
        const event = events[i];
        if (event !== undefined && event.type === "turn/end") {
          const kind = event.data.reason.kind;
          if (kind === "error" || kind === "blocked") {
            ok = false;
            reason = kind === "error" ? event.data.reason.message : (event.data.reason.reason ?? kind);
          } else {
            ok = true;
            reason = undefined;
          }
        }
      }
      rt.bridge.emitSettledFor({ threadId: threadIdAtKick, sendId: id, ok, reason });
    })
    .catch(() => {
      rt.pendingSends = Math.max(0, rt.pendingSends - 1);
      rt.bridge.emitSettledFor({ threadId: threadIdAtKick, sendId: id, ok: false, reason: "settle-failed" });
    });
  return true;
}

async function dispatchCommand(
  rt: WorkerRuntime,
  input: CommandInput,
  spec: { command: string; line: string; imagesPresent: boolean },
): Promise<boolean> {
  const registry = rt.state.commands;
  if (registry === undefined) return false;
  const session = sessionOf(rt);
  if (session === undefined) return false;
  const parsed = parseCommand(spec.line);
  if (spec.imagesPresent && parsed !== undefined && registry.find(parsed.name) !== undefined) {
    respond(rt, { id: input.id, command: spec.command, error: hubError("invalid_input", "invalid images: compact does not accept images") });
    return true;
  }
  const registration = rt.inflight.register();
  try {
    const execution = await registry.execute(session, spec.line, registration.signal);
    if (execution === undefined) return false;
    if (execution.result.kind === "error") {
      respond(rt, { id: input.id, command: spec.command, error: hubError("compact_rejected", execution.result.text) });
    } else {
      respond(rt, { id: input.id, command: spec.command, data: execution.result.data });
    }
    return true;
  } catch (error) {
    respond(rt, { id: input.id, command: spec.command, error: errorOfCause(error) });
    return true;
  } finally {
    registration.unregister();
  }
}

function promptStreamingBranch(
  rt: WorkerRuntime,
  input: CommandInput,
  payload: { message: string; images: WireImage[] | undefined },
): void {
  const behavior = input.streamingBehavior;
  if (behavior !== "steer" && behavior !== "followUp") {
    respond(rt, { id: input.id, command: "prompt", error: hubError("streaming_window", "streamingBehavior required while streaming") });
    return;
  }
  const agent = rt.state.handle?.agent;
  if (agent === undefined) {
    respond(rt, { id: input.id, command: "prompt", error: hubError("unknown_thread", "Unknown threadId") });
    return;
  }
  try {
    if (behavior === "steer") agent.steer(payload.message, imageOptions(payload.images));
    else agent.followup(payload.message, imageOptions(payload.images));
  } catch (error) {
    respond(rt, { id: input.id, command: "prompt", error: errorOfCause(error) });
    return;
  }
  respond(rt, { id: input.id, command: "prompt" });
  settleAfter(rt, input.id);
}

export function forkInputVerdict(rt: WorkerRuntime, lastSeq: number, input: CommandInput): HubErrorShape | undefined {
  if (rt.bridge.isStreaming()) return hubError("streaming_window", "thread is streaming");
  const seq = input.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return hubError("invalid_input", `invalid fork seq: ${String(seq)}`);
  if (seq > lastSeq) return hubError("cursor_stale", "fork beyond durable boundary");
  if (input.position !== "at" && seq === 0) return hubError("invalid_input", "fork before first event");
  return undefined;
}

export function createWorkerCommands(rt: WorkerRuntime): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerThreadCommands(rt, handlers);

  handlers.set("prompt", async (input) => {
    if (requireThread(rt, { ...input, command: "prompt" }) === undefined) return;
    const message = typeof input.message === "string" ? input.message : "";
    const parsedImages = parseImages(input.images);
    if (!parsedImages.ok) {
      respond(rt, { id: input.id, command: "prompt", error: hubError(parsedImages.code, parsedImages.reason) });
      return;
    }
    const gate = imagesGate(rt, parsedImages.images);
    if (gate !== undefined) {
      respond(rt, { id: input.id, command: "prompt", error: hubError("capability_images", gate) });
      return;
    }
    const dispatched = await dispatchCommand(rt, input, { command: "prompt", line: message, imagesPresent: input.images !== undefined });
    if (dispatched) return;
    if (rt.pendingSends > 0 || rt.bridge.isStreaming()) {
      promptStreamingBranch(rt, input, { message, images: parsedImages.images });
      return;
    }
    const agent = rt.state.handle?.agent;
    if (agent === undefined) {
      respond(rt, { id: input.id, command: "prompt", error: hubError("unknown_thread", "Unknown threadId") });
      return;
    }
    try {
      agent.followup(message, imageOptions(parsedImages.images));
    } catch (error) {
      respond(rt, { id: input.id, command: "prompt", error: errorOfCause(error) });
      return;
    }
    respond(rt, { id: input.id, command: "prompt" });
    settleAfter(rt, input.id);

  });

  handlers.set("steer", async (input) => {
    if (requireThread(rt, { ...input, command: "steer" }) === undefined) return;
    const parsedImages = parseImages(input.images);
    if (!parsedImages.ok) {
      respond(rt, { id: input.id, command: "steer", error: hubError(parsedImages.code, parsedImages.reason) });
      return;
    }
    const gate = imagesGate(rt, parsedImages.images);
    if (gate !== undefined) {
      respond(rt, { id: input.id, command: "steer", error: hubError("capability_images", gate) });
      return;
    }
    const agent = rt.state.handle?.agent;
    if (agent === undefined) {
      respond(rt, { id: input.id, command: "steer", error: hubError("unknown_thread", "Unknown threadId") });
      return;
    }
    try {
      agent.steer(typeof input.message === "string" ? input.message : "", imageOptions(parsedImages.images));
    } catch (error) {
      respond(rt, { id: input.id, command: "steer", error: errorOfCause(error) });
      return;
    }
    respond(rt, { id: input.id, command: "steer" });
    settleAfter(rt, input.id);

  });

  handlers.set("follow_up", async (input) => {
    if (requireThread(rt, { ...input, command: "follow_up" }) === undefined) return;
    const parsedImages = parseImages(input.images);
    if (!parsedImages.ok) {
      respond(rt, { id: input.id, command: "follow_up", error: hubError(parsedImages.code, parsedImages.reason) });
      return;
    }
    const gate = imagesGate(rt, parsedImages.images);
    if (gate !== undefined) {
      respond(rt, { id: input.id, command: "follow_up", error: hubError("capability_images", gate) });
      return;
    }
    const agent = rt.state.handle?.agent;
    if (agent === undefined) {
      respond(rt, { id: input.id, command: "follow_up", error: hubError("unknown_thread", "Unknown threadId") });
      return;
    }
    try {
      agent.followup(typeof input.message === "string" ? input.message : "", imageOptions(parsedImages.images));
    } catch (error) {
      respond(rt, { id: input.id, command: "follow_up", error: errorOfCause(error) });
      return;
    }
    respond(rt, { id: input.id, command: "follow_up" });
    settleAfter(rt, input.id);

  });

  handlers.set("abort", async (input) => {
    const session = requireThread(rt, { ...input, command: "abort" });
    if (session === undefined) return;
    rt.bash.abortAdmissions();
    rt.bash.abortRunning(undefined);
    rt.broker.denyAll();
    await rt.inflight.abortAll();
    if (rt.state.delegation !== undefined) {
      await rt.state.delegation.stopAll(session.id, "client-abort");
    }
    rt.state.handle?.agent.cancel("client-abort");
    respond(rt, { id: input.id, command: "abort" });
  });

  handlers.set("clear_queue", async (input) => {
    const session = requireThread(rt, { ...input, command: "clear_queue" });
    if (session === undefined) return;
    const before = foldQueue(session.events());
    const append = session.append("agent/inbox/spliced", { op: "clear", reason: "client-clear" });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "clear_queue", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "clear_queue", error: hubError("io_failed", flushed.reason) });
      return;
    }
    respond(rt, { id: input.id, command: "clear_queue", data: before });
  });

  handlers.set("queue/drop", async (input) => {
    const session = requireThread(rt, { ...input, command: "queue/drop" });
    if (session === undefined) return;
    const entryId = typeof input.entryId === "string" ? input.entryId : "";
    if (entryId === "") {
      respond(rt, { id: input.id, command: "queue/drop", error: hubError("invalid_input", "queue entryId required") });
      return;
    }
    const target = findQueueEntryTarget(session.events(), entryId);
    if (target === undefined) {
      respond(rt, { id: input.id, command: "queue/drop", error: hubError("state_conflict", `queue entry not found: ${entryId}`) });
      return;
    }
    const append = session.append("agent/inbox/spliced", { op: "drop", target, dropped: [entryId], reason: "client-drop" });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "queue/drop", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "queue/drop", error: hubError("io_failed", flushed.reason) });
      return;
    }
    respond(rt, { id: input.id, command: "queue/drop" });
  });

  handlers.set("queue/send_now", async (input) => {
    const session = requireThread(rt, { ...input, command: "queue/send_now" });
    if (session === undefined) return;
    const entryId = typeof input.entryId === "string" ? input.entryId : "";
    if (entryId === "") {
      respond(rt, { id: input.id, command: "queue/send_now", error: hubError("invalid_input", "queue entryId required") });
      return;
    }
    if (!foldInbox(session.events()).nextTurn.some((entry) => entry.id === entryId)) {
      respond(rt, { id: input.id, command: "queue/send_now", error: hubError("state_conflict", `queue entry not in follow-up queue: ${entryId}`) });
      return;
    }
    if (!rt.bridge.isStreaming() && rt.pendingSends === 0) {
      respond(rt, { id: input.id, command: "queue/send_now", error: hubError("streaming_window", "no running turn to steer into") });
      return;
    }
    const append = session.append("agent/inbox/spliced", { op: "retarget", id: entryId, to: "next-step" });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "queue/send_now", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "queue/send_now", error: hubError("io_failed", flushed.reason) });
      return;
    }
    respond(rt, { id: input.id, command: "queue/send_now" });
  });

  handlers.set("compact", async (input) => {
    if (requireThread(rt, { ...input, command: "compact" }) === undefined) return;
    const custom = typeof input.customInstructions === "string" && input.customInstructions.trim() !== "" ? input.customInstructions.trim() : undefined;
    const dispatched = await dispatchCommand(rt, input, { command: "compact", line: custom !== undefined ? `/compact ${custom}` : "/compact", imagesPresent: false });
    if (!dispatched) respond(rt, { id: input.id, command: "compact", error: hubError("unknown_command", "unknown command") });
  });

  createWorkflowHandlers({
    rt,
    respond: (frame) => respond(rt, frame),
    requireThread: (rtArg, input) => requireThread(rtArg as WorkerRuntime, { ...input, threadId: undefined } as Parameters<typeof requireThread>[1]),
  }).forEach(([name, handler]) => handlers.set(name, handler));

  handlers.set("fork", (input) => serializedLifecycle(() => doFork(rt, input, "fork")));

  handlers.set("clone", async (input) => {
    const session = requireThread(rt, { ...input, command: "clone" });
    if (session === undefined) return;
    await serializedLifecycle(() => doFork(rt, { ...input, seq: session.events().length - 1, position: "at" }, "clone"));
  });

  handlers.set("set_model", async (input) => {
    const session = requireThread(rt, { ...input, command: "set_model" });
    if (session === undefined) return;
    const provider = typeof input.provider === "string" ? input.provider : "";
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    if (catalogEntryOf(rt.state.catalog, { provider, model: modelId }) === undefined) {
      respond(rt, {
        id: input.id,
        command: "set_model",
        error: hubError("model_unavailable", `unknown model preset: ${modelId} (available: ${catalogModelIds(rt.state.catalog).join(", ")})`),
      });
      return;
    }
    const candidate = { ...currentDialOf(session.events(), rt.state.dial), provider, model: modelId };
    const thinking = currentThinkingOf(session.events(), rt.state.thinking);
    const unsupported = thinkingUnsupported(rt.state.catalog, candidate, thinking);
    if (unsupported !== undefined) {
      respond(rt, {
        id: input.id,
        command: "set_model",
        error: hubError("model_unavailable", `cannot switch model: ${unsupported} — set_thinking_level off first or pick a compatible model`),
      });
      return;
    }
    const append = session.append("session/meta", { key: META_KEY_DIAL, value: { provider: candidate.provider, model: candidate.model } });
    if (!append.ok) {
      respond(rt, { id: input.id, command: "set_model", error: hubError("io_failed", append.reason) });
      return;
    }
    const flushed = await rt.state.world?.store.flush(session.id);
    if (flushed !== undefined && !flushed.ok) {
      respond(rt, { id: input.id, command: "set_model", error: hubError("io_failed", flushed.reason) });
      return;
    }
    respond(rt, { id: input.id, command: "set_model" });
  });

  handlers.set("ui_response", wrapSyncHandler((input) => {
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    if (requestId === "") return;
    rt.broker.resolve(requestId, input.payload);
  }));

  handlers.set("subagent/steer", async (input) => {
    if (requireThread(rt, { ...input, command: "subagent/steer" }) === undefined) return;
    const view = rt.state.delegation;
    const agentId = typeof input.agentId === "string" ? input.agentId : "";
    const caller = rt.state.threadId as SessionId;
    if (view === undefined) {
      respond(rt, { id: input.id, command: "subagent/steer", error: hubError("invalid_input", `subagent ${agentId} not available (status: unknown)`) });
      return;
    }
    const rows = await view.list(caller);
    const row = rows.find((entry) => entry.kind === "subagent" && entry.agentId === agentId);
    if (row === undefined) {
      respond(rt, { id: input.id, command: "subagent/steer", error: hubError("invalid_input", `subagent ${agentId} not available (status: unknown)`) });
      return;
    }
    const sent = await view.message(caller, { to: agentId, message: typeof input.message === "string" ? input.message : "" });
    respond(rt, sent.ok ? { id: input.id, command: "subagent/steer" } : { id: input.id, command: "subagent/steer", error: delegationError(sent.reason) });
  });

  registerReadCommands(rt, handlers);
  registerMetaCommands(rt, handlers);
  handlers.set("plugins/hot_install", (input) => handleHotInstall(rt, input));
  handlers.set("plugins/hot_uninstall", (input) => handleHotUninstall(rt, input));
  registerBashCommands(rt, handlers);

  return handlers;
}
