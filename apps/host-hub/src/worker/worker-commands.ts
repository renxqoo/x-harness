import type { Session, SessionId } from "@x-harness/session";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { World } from "@x-harness/harness";
import type { ThinkingLevel } from "@x-harness/llm";
import type { PermissionModeService } from "@x-harness/permission";
import { hubError } from "../shared/errors.ts";
import { anchorAtKick, anchorVerdictOf } from "./settle-anchor.ts";
import { clearQueue as sdkClearQueue, queueDrop as sdkQueueDrop, queueSendNow as sdkQueueSendNow } from "@x-harness/agent-sdk/src/commands/queue.ts";
import { prompt as sdkPrompt, steer as sdkSteer, followUp as sdkFollowUp, dispatchCommand as sdkDispatchCommand } from "@x-harness/agent-sdk/src/commands/send.ts";
import type { QueueCommandState } from "@x-harness/agent-sdk/src/commands/queue.ts";
import { outcomeRespond } from "./outcome-bridge.ts";
import type { KickAnchor } from "./settle-anchor.ts";
import type { HubErrorShape } from "../shared/errors.ts";
import type { DelegationView } from "@x-harness/agent-delegation";
import { responseFrame } from "../protocol/frames.ts";
import { createWorkflowHandlers } from "./workflow-commands.ts";
import { catalogEntryOf, catalogModelIds } from "../shared/worker-catalog.ts";
import type { WorkerCatalog } from "../shared/worker-catalog.ts";
import type { DialFact } from "../shared/meta-fold.ts";
import type { ScriptAdapter } from "../shared/script-adapter.ts";
import { currentDialOf, currentThinkingOf, thinkingUnsupported, META_KEY_DIAL } from "./meta-state.ts";
import type { DialogBroker } from "./dialogs.ts";
import type { BashExec } from "./bash-exec.ts";
import type { EventBridge } from "./event-bridge.ts";
import type { InflightRegistry, InflightState } from "./inflight.ts";
import { doFork, registerThreadCommands, serializedLifecycle } from "./thread-commands.ts";
import { parseReloadCatalog, swapWorldAdapters } from "./catalog-reload.ts";
import { registerReadCommands } from "./worker-read-commands.ts";
import { registerMetaCommands } from "./worker-meta-commands.ts";
import { handleHotInstall, handleHotUninstall } from "./plugins-hot.ts";
import { registerBashCommands } from "./bash-commands.ts";


export interface CatalogBox {
  current: WorkerCatalog;
}

export interface WorkerState {
  handle: AgentHandle | undefined;
  world: World | undefined;
  catalog: WorkerCatalog;
  catalogBox: CatalogBox;
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
      ...(typeof target.id === "string" && target.id !== "" ? { id: target.id } : {}),
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



function delegationError(reason: string): HubErrorShape {
  if (reason.startsWith("invalid-args:") || reason.startsWith("not-found:") || reason.startsWith("not-owner:")) return hubError("invalid_input", reason);
  if (reason.startsWith("not-live:")) return hubError("thread_not_live", reason);
  if (reason.startsWith("busy:")) return hubError("thread_limit", reason);
  return hubError("internal", reason);
}

export function settleAfter(rt: WorkerRuntime, id: string | undefined, kickAnchor: KickAnchor | undefined): boolean {
  if (id === undefined || kickAnchor === undefined) return false;
  const handle = rt.state.handle;
  if (handle === undefined) return false;
  const threadIdAtKick = kickAnchor.threadIdAtKick;
  const marker = kickAnchor.marker;
  const anchorTurn = kickAnchor.anchorTurn;
  rt.pendingSends += 1;
  void handle.agent
    .whenIdle()
    .then(() => {
      rt.pendingSends = Math.max(0, rt.pendingSends - 1);
      const events = handle.agent.session.events();
      const verdict = anchorVerdictOf(events, { anchorTurn, fromSeq: marker, agent: handle.agent });
      rt.bridge.emitSettledFor({ threadId: threadIdAtKick, sendId: id, ...verdict });
    })
    .catch(() => {
      rt.pendingSends = Math.max(0, rt.pendingSends - 1);
      rt.bridge.emitSettledFor({ threadId: threadIdAtKick, sendId: id, ok: false, reason: "settle-failed" });
    });
  return true;
}


function sendStateOf(rt: WorkerRuntime): import("@x-harness/agent-sdk/src/commands/send.ts").SendCommandState {
  return {
    session: rt.state.handle?.agent.session,
    currentThreadId: rt.state.threadId === "" ? undefined : rt.state.threadId,
    catalog: rt.state.catalog,
    dial: rt.state.dial,
    commands: rt.state.commands as { find(name: string): unknown; execute(session: never, line: string, signal: AbortSignal): Promise<{ result: { kind: string; text: string; data?: unknown } } | undefined> } | undefined,
    agent: rt.state.handle?.agent,
    streaming: () => rt.bridge.isStreaming(),
    pendingSends: () => rt.pendingSends,
    bash: { abortAdmissions: () => rt.bash.abortAdmissions(), abortRunning: (id) => rt.bash.abortRunning(id) },
    broker: { denyAll: () => rt.broker.denyAll() },
    inflight: rt.inflight,
    delegation: rt.state.delegation,
    beginSettle: (requestId: string | undefined, steerIntoRunning: boolean) => anchorAtKick(rt, requestId, steerIntoRunning),
    settle: (anchor: unknown) => {
      const kick = anchor as { id: string } | undefined;
      if (kick !== undefined) settleAfter(rt, kick.id, kick as never);
    },
  };
}

function sdkQueueState(rt: WorkerRuntime): QueueCommandState {
  return {
    session: sessionOf(rt),
    currentThreadId: rt.state.threadId === "" ? undefined : rt.state.threadId,
    world: { flush: async (id) => {
      const flushed = await rt.state.world?.store.flush(id);
      return flushed;
    } },
    streaming: () => rt.bridge.isStreaming(),
    pendingSends: () => rt.pendingSends,
  };
}

export function createWorkerCommands(rt: WorkerRuntime): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerThreadCommands(rt, handlers);

  handlers.set("prompt", async (input) => {
    if (requireThread(rt, { ...input, command: "prompt" }) === undefined) return;
    const outcome = await sdkPrompt(sendStateOf(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("steer", async (input) => {
    if (requireThread(rt, { ...input, command: "steer" }) === undefined) return;
    const outcome = await sdkSteer(sendStateOf(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("follow_up", async (input) => {
    if (requireThread(rt, { ...input, command: "follow_up" }) === undefined) return;
    const outcome = await sdkFollowUp(sendStateOf(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
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
    if (requireThread(rt, { ...input, command: "clear_queue" }) === undefined) return;
    const outcome = await sdkClearQueue(sdkQueueState(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("queue/drop", async (input) => {
    if (requireThread(rt, { ...input, command: "queue/drop" }) === undefined) return;
    const outcome = await sdkQueueDrop(sdkQueueState(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("queue/send_now", async (input) => {
    if (requireThread(rt, { ...input, command: "queue/send_now" }) === undefined) return;
    const outcome = await sdkQueueSendNow(sdkQueueState(rt), input);
    outcomeRespond((line) => rt.emitLine(line), input.id, outcome);
  });

  handlers.set("compact", async (input) => {
    if (requireThread(rt, { ...input, command: "compact" }) === undefined) return;
    const custom = typeof input.customInstructions === "string" && input.customInstructions.trim() !== "" ? input.customInstructions.trim() : undefined;
    const dispatched = await sdkDispatchCommand(sendStateOf(rt), input.id, { command: "compact", line: custom !== undefined ? `/compact ${custom}` : "/compact", imagesPresent: false });
    if (dispatched === undefined) respond(rt, { id: input.id, command: "compact", error: hubError("unknown_command", "unknown command") });
    else outcomeRespond((line) => rt.emitLine(line), input.id, dispatched);
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

  handlers.set("catalog/reload", async (input) => {
    const next = parseReloadCatalog(input.catalog);
    if (next === undefined) {
      respond(rt, { id: input.id, command: "catalog/reload", error: hubError("invalid_input", "invalid catalog payload") });
      return;
    }
    const swapped = swapWorldAdapters(rt, next);
    rt.state.catalog = next;
    rt.state.catalogBox.current = next;
    respond(rt, { id: input.id, command: "catalog/reload", data: { providers: next.providers.length, adaptersSwapped: swapped } });
  });

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
