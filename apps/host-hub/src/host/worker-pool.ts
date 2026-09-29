import { DRIVING_COMMANDS, HOST_RELAYED_THREAD_COMMANDS, INTERNAL_ID_PREFIX, isLiveOnly, isThreadScoped } from "../protocol/internal.ts";
import { routeLiveOnly } from "./route-gates.ts";
import type { ThreadEntry, ThreadTable } from "./thread-table.ts";
import { spawnWorker, workerExecPath } from "./worker-process.ts";
import type { WorkerHandle } from "./worker-process.ts";
import { createFrameRelay } from "./worker-frames.ts";
import type { FrameRelay } from "./worker-frames.ts";
import { createControlRouter } from "./worker-control.ts";
import { FORK_GRACE_SIGTERM_MS, PENDING_COMMANDS_CAP, WORKER_SPAWN_TIMEOUT_MS } from "../shared/limits.ts";
import { responseFrame, threadDiedFrame, threadParkedFrame } from "../protocol/frames.ts";
import { hubError, type HubErrorShape } from "../shared/errors.ts";

export interface PoolDeps {
  table: ThreadTable;
  emitClient: (line: string) => void;
  limits: { maxThreads: number; workerExitTimeoutMs: number };
  workerEnv: () => Record<string, string>;
  spawn?: typeof spawnWorker;
}

export type RetireOrigin = "manual" | "idle" | "rss";

interface LiveSlot {
  worker: WorkerHandle;
  threadId: string;
  relay: FrameRelay;
  pendingIds: Set<string>;
  drivingIds: Set<string>;
  resumeWaiter: { resolve: (ok: boolean, reason?: HubErrorShape) => void } | undefined;
  retireIntent: "stop" | "retire" | undefined;
  retireReason: RetireOrigin;
  spawnDeadline: ReturnType<typeof setTimeout> | undefined;
  helloOk: boolean;
  internalQueries: Map<string, { resolve: (data: unknown) => void }>;
}

const MAX_REQUEUE_PER_THREAD = 1_024;
const MAX_REQUEUE_BYTES_PER_THREAD = 4 * 1024 * 1024;

export function createWorkerPool(deps: PoolDeps) {
  const slots = new Map<string, LiveSlot>();
  const byThread = new Map<string, string>();
  const pendingCommands = new Map<string, string>();
  let internalSeq = 0;
  let pendingSeq = 0;
  let shuttingDown = false;
  const requeue = new Map<string, string[]>();
  const waking = new Map<string, Promise<boolean>>();

  function nextInternalId(): string {
    internalSeq += 1;
    return `${INTERNAL_ID_PREFIX}${internalSeq}`;
  }

  function slotOf(threadId: string): LiveSlot | undefined {
    const uid = byThread.get(threadId);
    return uid !== undefined ? slots.get(uid) : undefined;
  }

  function emitFailure(id: string | undefined, command: string, error: HubErrorShape): void {
    deps.emitClient(
      responseFrame({
        ...(id !== undefined && id !== "" ? { id } : {}),
        command,
        success: false,
        error,
      }),
    );
  }

  function releaseSlotDebts(slot: LiveSlot): void {
    for (const id of slot.pendingIds) {
      emitFailure(id, pendingCommands.get(id) ?? "unknown", hubError("protocol", "worker died before responding"));
      pendingCommands.delete(id);
    }
    for (const sendId of slot.drivingIds) {
      const owner = slot.threadId;
      deps.emitClient(
        `{"type":"event","threadId":${JSON.stringify(owner)},"name":"settled","payload":{"sendId":${JSON.stringify(sendId)},"ok":false,"reason":"worker-died"}}`,
      );
      pendingCommands.delete(sendId);
    }
    slot.resumeWaiter?.resolve(false);
    for (const waiter of slot.internalQueries.values()) waiter.resolve(undefined);
    slot.internalQueries.clear();
    if (slot.spawnDeadline !== undefined) clearTimeout(slot.spawnDeadline);
  }

  function settleThreadOutcome(slot: LiveSlot, entry: ThreadEntry): void {
    const { threadId } = slot;
    const intent = slot.retireIntent ?? entry.retireIntent;
    if (intent === "stop") {
      deps.table.remove(threadId);
    } else if (intent === "retire") {
      if (entry.sessionPath !== null) {
        deps.table.update(threadId, { state: "parked", isStreaming: false, rssBytes: null });
        deps.emitClient(threadParkedFrame(threadId, slot.retireReason));
      } else {
        deps.table.update(threadId, { state: "dead" });
        deps.emitClient(threadDiedFrame(threadId, "retire of unpersisted worker"));
      }
    } else if (slot.helloOk !== true) {
      if (entry.sessionPath !== null) {
        deps.table.update(threadId, { state: "dead", isStreaming: false });
      } else {
        deps.table.remove(threadId);
      }
    } else {
      deps.table.update(threadId, { state: "dead", isStreaming: false });
      deps.emitClient(threadDiedFrame(threadId, "worker exited unexpectedly"));
    }
  }

  function settleClose(slot: LiveSlot): void {
    const { threadId } = slot;
    const entry = deps.table.get(threadId);
    slots.delete(slot.worker.uid);
    byThread.delete(threadId);
    if (shuttingDown) {
      slot.resumeWaiter?.resolve(false);
      slot.resumeWaiter = undefined;
      if (slot.spawnDeadline !== undefined) clearTimeout(slot.spawnDeadline);
      requeue.delete(threadId);
      requeueBytes.delete(threadId);
      return;
    }
    releaseSlotDebts(slot);
    if (threadId.startsWith("@pending")) return;
    if (entry === undefined) return;
    settleThreadOutcome(slot, entry);
    const queued = requeue.get(threadId);
    requeue.delete(threadId);
    requeueBytes.delete(threadId);
    if (queued !== undefined) {
      void (async () => {
        for (const line of queued) await routeLine(line);
      })();
    }
  }

  const routeControl = createControlRouter({ table: deps.table, emitClient: deps.emitClient });

  function spawnSlot(threadId: string, trusted: boolean, cwd: string): LiveSlot {
    const slot = createBareSlot(threadId);
    const rebind = (next: string): void => {
      byThread.delete(slot.threadId);
      slot.threadId = next;
      byThread.set(next, slot.worker.uid);
    };
    slot.relay = createFrameRelay({
      emitClient: deps.emitClient,
      onHelloRejected: (reason) => {
        process.stderr.write(`hub: hello rejected (${threadId}): ${reason}\n`);
        slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      },
      onHeartbeat: (beat) => {
        const entry = deps.table.get(slot.threadId);
        if (
          beat.sessionPath !== null &&
          entry !== undefined &&
          entry.sessionPath !== null &&
          entry.sessionPath !== beat.sessionPath
        ) {
          process.stderr.write(`hub: worker session rekey (${slot.threadId}: ${entry.sessionPath} -> ${beat.sessionPath})\n`);
        }
        deps.table.applyHeartbeat(slot.threadId, beat);
        if (slot.spawnDeadline !== undefined) {
          clearTimeout(slot.spawnDeadline);
          slot.spawnDeadline = undefined;
        }
      },
      onResponse: (id, success) => {
        if (id === undefined) return;
        slot.pendingIds.delete(id);
        pendingCommands.delete(id);
        if (!success) slot.drivingIds.delete(id);
      },
      onControlResponse: (frame) => {
        const waiter = frame.id !== undefined ? slot.internalQueries.get(frame.id) : undefined;
        if (waiter !== undefined) {
          if (frame.id !== undefined) slot.internalQueries.delete(frame.id);
          waiter.resolve(frame.data);
          return false;
        }
        return routeControl({ slot, rebind, trusted, cwd }, frame);
      },
      onSettled: (sendId) => {
        slot.drivingIds.delete(sendId);
        pendingCommands.delete(sendId);
      },
      onViolation: (reason) => {
        process.stderr.write(`hub: worker protocol violation (${threadId}): ${reason}\n`);
        slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      },
    });
    slot.worker = (deps.spawn ?? spawnWorker)({
      env: deps.workerEnv(),
      exec: workerExecPath(),
      stderrPrefix: `[hub:worker:${threadId}]`,
      onLine: (line) => {
        if (slot.relay.ingest(line)) slot.helloOk = true;
      },
      onViolation: (reason) => {
        process.stderr.write(`hub: worker line violation (${threadId}): ${reason}\n`);
        slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      },
      onClosed: () => settleClose(slot),
    });
    slots.set(slot.worker.uid, slot);
    byThread.set(threadId, slot.worker.uid);
    slot.spawnDeadline = setTimeout(() => {
      if (!slot.helloOk) {
        process.stderr.write(`hub: worker spawn deadline (${threadId})\n`);
        slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      }
    }, WORKER_SPAWN_TIMEOUT_MS);
    return slot;
  }

  function createBareSlot(threadId: string): LiveSlot {
    return {
      worker: undefined as unknown as WorkerHandle,
      threadId,
      relay: undefined as unknown as FrameRelay,
      pendingIds: new Set<string>(),
      drivingIds: new Set<string>(),
      resumeWaiter: undefined,
      retireIntent: undefined,
      retireReason: "manual",
      spawnDeadline: undefined,
      helloOk: false,
      internalQueries: new Map(),
    };
  }

  function pendingCommandInfo(line: string): { id?: string; type: string } {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; type?: unknown };
      const info: { id?: string; type: string } = { type: typeof parsed.type === "string" ? parsed.type : "unknown" };
      if (typeof parsed.id === "string") info.id = parsed.id;
      return info;
    } catch {
      return { type: "unknown" };
    }
  }

  function deliverTo(uid: string, line: string, info: { id?: string; type: string }): void {
    const slot = slots.get(uid);
    if (slot === undefined) return;
    if (pendingCommands.size >= PENDING_COMMANDS_CAP && info.id !== undefined && !pendingCommands.has(info.id)) {
      emitFailure(info.id, info.type, hubError("thread_limit", "too many in-flight commands"));
      return;
    }
    if (info.id !== undefined) {
      slot.pendingIds.add(info.id);
      pendingCommands.set(info.id, info.type);
      if (DRIVING_COMMANDS.has(info.type)) {
        slot.drivingIds.add(info.id);
      }
    }
    void slot.worker.write(line);
  }

  const requeueBytes = new Map<string, number>();

  function requeueLine(threadId: string, line: string): void {
    const queue = requeue.get(threadId) ?? [];
    const bytes = (requeueBytes.get(threadId) ?? 0) + line.length;
    if (queue.length >= MAX_REQUEUE_PER_THREAD || bytes > MAX_REQUEUE_BYTES_PER_THREAD) return;
    queue.push(line);
    requeue.set(threadId, queue);
    requeueBytes.set(threadId, bytes);
  }

  function deliverIfLive(threadId: string, line: string, info: { id?: string; type: string }): boolean {
    const slot = slotOf(threadId);
    if (slot === undefined) return false;
    deliverTo(slot.worker.uid, line, info);
    return true;
  }

  function occupiedThreads(): number {
    let pending = 0;
    for (const id of byThread.keys()) {
      if (id.startsWith("@pending")) pending += 1;
    }
    return deps.table.liveCount() + pending;
  }

  function beginThread(line: string, trusted: boolean, cwd: string): { ok: true } | { ok: false; reason: HubErrorShape } {
    if (occupiedThreads() >= deps.limits.maxThreads) {
      return { ok: false, reason: hubError("thread_limit", "too many live threads (limit reached)") };
    }
    pendingSeq += 1;
    const pendingId = `@pending-${pendingSeq}`;
    const slot = spawnSlot(pendingId, trusted, cwd);
    deliverTo(slot.worker.uid, line, pendingCommandInfo(line));
    if (occupiedThreads() > deps.limits.maxThreads) {
      process.stderr.write("hub: thread budget exceeded after spawn; killing newest\n");
      slot.worker.kill(FORK_GRACE_SIGTERM_MS);
    }
    return { ok: true };
  }

  function beginKnown(threadId: string, line: string): void {
    const entry = deps.table.get(threadId);
    if (entry === undefined) return;
    const slot = spawnSlot(threadId, entry.trusted, entry.cwd);
    deliverTo(slot.worker.uid, line, pendingCommandInfo(line));
  }

  async function wake(threadId: string): Promise<boolean> {
    const inflight = waking.get(threadId);
    if (inflight !== undefined) return inflight;
    const flight = wakeOnce(threadId).finally(() => waking.delete(threadId));
    waking.set(threadId, flight);
    return flight;
  }

  async function wakeOnce(threadId: string): Promise<boolean> {
    const entry = deps.table.get(threadId);
    if (entry === undefined || entry.sessionPath === null) return false;
    if (deps.table.liveCount() >= deps.limits.maxThreads) return false;
    if (slotOf(threadId) !== undefined) return true;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await Bun.sleep(1_000);
      deps.table.update(threadId, { state: "spawning" });
      const slot = spawnSlot(threadId, entry.trusted, entry.cwd);
      const internalId = nextInternalId();
      const verdict = await new Promise<{ ok: boolean; reason?: HubErrorShape }>((resolve) => {
        let settled = false;
        const finish = (ok: boolean, reason?: HubErrorShape): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ ok, ...(reason !== undefined ? { reason } : {}) });
        };
        const deadline = setTimeout(() => finish(false, hubError("protocol", "resume deadline exceeded")), WORKER_SPAWN_TIMEOUT_MS);
        slot.resumeWaiter = {
          resolve: (ok, reason) => finish(ok, reason),
        };
        void slot.worker.write(
          JSON.stringify({
            id: internalId,
            type: "thread/resume",
            sessionPath: entry.sessionPath,
            trusted: entry.trusted,
            cwd: entry.cwd,
          }),
        );
      });
      if (verdict.ok) return true;
      process.stderr.write(`hub: wake resume failed (attempt ${attempt + 1}): ${verdict.reason?.message ?? "unknown"}\n`);
      slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      await Promise.race([slot.worker.exited, Bun.sleep(FORK_GRACE_SIGTERM_MS + 1_000)]);
      if (deps.table.get(threadId) === undefined) return false;
      if (deps.table.get(threadId)?.state === "parked") return false;
    }
    process.stderr.write(`hub: wake retries exhausted (${threadId})\n`);
    deps.table.update(threadId, { state: "dead" });
    return false;
  }

  function parseRouteLine(line: string): { id: string | undefined; type: string; threadId: string } | undefined {
    let input: { type?: unknown; id?: unknown; threadId?: unknown };
    try {
      input = JSON.parse(line) as { type?: unknown; id?: unknown; threadId?: unknown };
    } catch (error) {
      process.stderr.write(`hub: pool parse failure: ${String(error)}\n`);
      emitFailure(undefined, "parse", hubError("protocol", "parse failure"));
      return undefined;
    }
    return {
      type: typeof input.type === "string" ? input.type : "",
      id: typeof input.id === "string" ? input.id : undefined,
      threadId: typeof input.threadId === "string" ? input.threadId : "",
    };
  }

  function routeGateFailure(id: string | undefined, type: string, threadId: string): { code: "protocol" | "unknown_command" | "invalid_input"; message: string } | undefined {
    if (id !== undefined && id.startsWith(INTERNAL_ID_PREFIX)) return { code: "protocol", message: "invalid id: reserved namespace" };
    if (!isThreadScoped(type) && !HOST_RELAYED_THREAD_COMMANDS.has(type)) return { code: "unknown_command", message: "unknown command" };
    if (threadId === "") return { code: "invalid_input", message: "threadId required" };
    return undefined;
  }

  async function routeLine(line: string): Promise<void> {
    const parsed = parseRouteLine(line);
    if (parsed === undefined) return;
    const { id, type, threadId } = parsed;
    const gate = routeGateFailure(id, type, threadId);
    if (gate !== undefined) {
      emitFailure(id, type, hubError(gate.code, gate.message));
      return;
    }
    const entry = deps.table.get(threadId);
    if (entry === undefined) {
      emitFailure(id, type, hubError("unknown_thread", "Unknown threadId"));
      return;
    }
    if (isLiveOnly(type)) {
      const consumed = routeLiveOnly({ id, type, threadId, entry, line }, { emitFailure, deliver: deliverIfLive });
      if (consumed) return;
    }
    if (entry.state === "retiring") {
      requeueLine(threadId, line);
      return;
    }
    const info: { id?: string; type: string } = { type };
    if (id !== undefined) info.id = id;
    if (deliverIfLive(threadId, line, info)) return;
    if (await wake(threadId)) {
      if (deliverIfLive(threadId, line, info)) return;
    }
    process.stderr.write(`hub: routeLine wake failed for ${threadId} (entry=${deps.table.get(threadId) !== undefined ? deps.table.get(threadId)?.state : "gone"})\n`);
    emitFailure(id, type, hubError("unknown_thread", "Unknown threadId"));
  }

  async function deliverRaw(threadId: string, line: string): Promise<void> {
    const slot = slotOf(threadId);
    if (slot !== undefined) await slot.worker.write(line);
  }

  function retireThread(threadId: string, intent: "stop" | "retire", origin: RetireOrigin = "manual"): "ok" | "not-persisted" | "in-flight" {
    const entry = deps.table.get(threadId);
    if (entry === undefined) return "ok";
    const slot = slotOf(threadId);
    if (slot === undefined) {
      if (entry.state === "spawning") return "in-flight";
      if (intent === "stop") {
        deps.table.remove(threadId);
      } else if (entry.sessionPath === null) {
        return "not-persisted";
      } else {
        deps.table.update(threadId, { state: "parked" });
      }
      return "ok";
    }
    if (intent === "retire" && entry.sessionPath === null) {
      return "not-persisted";
    }
    if (slot.retireIntent === undefined) {
      slot.retireIntent = intent;
      slot.retireReason = origin;
      deps.table.update(threadId, { state: "retiring", retireIntent: intent });
      if (intent === "stop") {
        void slot.worker.write(JSON.stringify({ id: nextInternalId(), type: "thread/stop" }));
      } else {
        slot.worker.eof();
      }
      const handle = slot.worker;
      setTimeout(() => handle.kill(deps.limits.workerExitTimeoutMs), 0);
    } else if (intent === "stop" && slot.retireIntent === "retire") {
      slot.retireIntent = "stop";
      deps.table.update(threadId, { retireIntent: "stop" });
    }
    return "ok";
  }

  function killStale(threadId: string): void {
    slotOf(threadId)?.worker.kill(FORK_GRACE_SIGTERM_MS);
  }

  async function queryLiveWorkers(type: string, timeoutMs: number): Promise<unknown[]> {
    const results: unknown[] = [];
    const live = liveThreadIds();
    if (live.length === 0) return results;
    const waits: Array<Promise<void>> = [];
    for (const threadId of live) {
      const slot = slotOf(threadId);
      if (slot === undefined) continue;
      const id = nextInternalId();
      const wait = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const waiter = slot.internalQueries.get(id);
          if (waiter !== undefined) {
            slot.internalQueries.delete(id);
            waiter.resolve(undefined);
          }
        }, timeoutMs);
        slot.internalQueries.set(id, {
          resolve: (data) => {
            clearTimeout(timer);
            if (data !== undefined && data !== null) results.push(data);
            resolve();
          },
        });
      });
      waits.push(wait);
      void slot.worker.write(JSON.stringify({ id, type, threadId }));
    }
    await Promise.all(waits);
    return results;
  }

  function liveThreadIds(): string[] {
    return [...byThread.keys()].filter((id) => !id.startsWith("@pending"));
  }

  async function shutdownAll(): Promise<void> {
    shuttingDown = true;
    const waits: Promise<void>[] = [];
    for (const slot of slots.values()) {
      slot.worker.eof();
      waits.push(slot.worker.exited);
      const handle = slot.worker;
      setTimeout(() => handle.kill(FORK_GRACE_SIGTERM_MS), deps.limits.workerExitTimeoutMs);
    }
    await Promise.all(waits.map((p) => Promise.race([p, Bun.sleep(30_000)])));
    shuttingDown = false;
  }

  return {
    routeLine,
    wake,
    beginThread,
    beginKnown,
    deliverRaw,
    queryLiveWorkers,
    slotOf,
    retireThread,
    killStale,
    liveThreadIds,
    table: deps.table,
    shutdownAll,
  };
}

export type WorkerPool = ReturnType<typeof createWorkerPool>;
