// worker 池（编排中枢，DESIGN §7）：唤醒/排队循环（retiring 等 close 再重评）；
// internal id `@hub-internal:` 不可碰撞命名空间按 worker 域键；deliverCommand 先记
// pendingIds 再写（响应核销 onResponse——失败响应同时核销全局 pendingCommands 与
// 在飞驱动登记：受理前被拒无 settled 义务）；在飞驱动 id 登记（settled 恰一的
// host 侧数据源——worker 死亡合成 settled{ok:false,reason:"worker-died"}）；
// shutdownAll EOF+期限+SIGKILL 不发死亡帧；close 结算（恰一合成 failure /
// thread_died 恰一 / parked 恰一 / stop 删表无帧；关闭期在飞不补响应不发帧）。
// thread/start 以 pending 表项起步、应答时落实表；start/resume 失败应答转发后
// 回收 worker（无会话存在——@pending 撤位经 close 结算）。
import { DRIVING_COMMANDS, HOST_RELAYED_THREAD_COMMANDS, INTERNAL_ID_PREFIX, isThreadScoped } from "../protocol/internal.ts";
import type { ThreadEntry, ThreadTable } from "./thread-table.ts";
import { spawnWorker, workerExecPath } from "./worker-process.ts";
import type { WorkerHandle } from "./worker-process.ts";
import { createFrameRelay } from "./worker-frames.ts";
import type { FrameRelay } from "./worker-frames.ts";
import { createControlRouter } from "./worker-control.ts";
import { FORK_GRACE_SIGTERM_MS, PENDING_COMMANDS_CAP, WORKER_SPAWN_TIMEOUT_MS } from "../shared/limits.ts";
import { responseFrame, threadDiedFrame, threadParkedFrame } from "../protocol/frames.ts";

export interface PoolDeps {
  table: ThreadTable;
  emitClient: (line: string) => void;
  limits: { maxThreads: number; workerExitTimeoutMs: number };
  workerEnv: () => Record<string, string>;
  /** spawn 注入缝（单测假 worker；缺省真进程） */
  spawn?: typeof spawnWorker;
}

/** thread_parked reason 域（DESIGN §4）：收编来源 */
export type RetireOrigin = "manual" | "idle" | "rss";

interface LiveSlot {
  worker: WorkerHandle;
  threadId: string;
  relay: FrameRelay;
  pendingIds: Set<string>;
  drivingIds: Set<string>;
  resumeWaiter: { resolve: (ok: boolean, reason?: string) => void } | undefined;
  retireIntent: "stop" | "retire" | undefined;
  /** 收编原因（close 结算 thread_parked 帧的 reason——随发起方定值） */
  retireReason: RetireOrigin;
  spawnDeadline: ReturnType<typeof setTimeout> | undefined;
  helloOk: boolean;
}

/** retiring 重放队列上限（风暴丢行：重发可重试——retiring 本就重评） */
const MAX_REQUEUE_PER_THREAD = 1_024;
/** retiring 重放队列字节预算（行限 16MiB 下 1024 行可达 16GiB——4MiB 封顶防 OOM） */
const MAX_REQUEUE_BYTES_PER_THREAD = 4 * 1024 * 1024;

export function createWorkerPool(deps: PoolDeps) {
  const slots = new Map<string, LiveSlot>();
  const byThread = new Map<string, string>();
  const pendingCommands = new Map<string, string>();
  let internalSeq = 0;
  let pendingSeq = 0;
  let shuttingDown = false;
  const requeue = new Map<string, string[]>();
  /** in-flight wake 守卫：同线程 wake 单飞——重试间隙的第二唤醒复用首次结果，
   *  杜绝 byThread 遮蔽/活线程被误判死 */
  const waking = new Map<string, Promise<boolean>>();

  function nextInternalId(): string {
    internalSeq += 1;
    return `${INTERNAL_ID_PREFIX}${internalSeq}`;
  }

  function slotOf(threadId: string): LiveSlot | undefined {
    const uid = byThread.get(threadId);
    return uid !== undefined ? slots.get(uid) : undefined;
  }

  function emitFailure(id: string | undefined, command: string, error: string): void {
    deps.emitClient(
      responseFrame({
        ...(id !== undefined && id !== "" ? { id } : {}),
        command,
        success: false,
        error,
      }),
    );
  }

  /** close 结算债务面：pending 补恰一 failure / 在飞驱动合成 settled / 等待者释放 */
  function releaseSlotDebts(slot: LiveSlot): void {
    for (const id of slot.pendingIds) {
      emitFailure(id, pendingCommands.get(id) ?? "unknown", "worker died before responding");
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
    if (slot.spawnDeadline !== undefined) clearTimeout(slot.spawnDeadline);
  }

  /** close 结算表迁移面：按 retireIntent / helloOk 定 parked|dead|删表（恰一帧） */
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
      // hello 不符/spawn 失败：已落盘表项保 dead（复活可重试），未落盘/挂起项撤位
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
      // 关闭期在飞不补响应、不发死亡帧（连接在关——客户端不再消费）；内部等待
      // 者与死线仍兑现（悬挂 promise/定时器不外溢）
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
      // 顺序重放（for-await）：重评路由串行——后续命令见到的表状态按序演进
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
          // path→path 变化（唤醒后 worker 落到不同会话 id）：占用重指 + warn
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
        if (!success) slot.drivingIds.delete(id); // 受理前被拒：无 settled 义务
      },
      onControlResponse: (frame) => routeControl({ slot, rebind, trusted, cwd }, frame),
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
      emitFailure(info.id, info.type, "too many in-flight commands");
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

  /** retiring 重评队列：close 结算后按原序重投递（行数 + 字节双预算） */
  function requeueLine(threadId: string, line: string): void {
    const queue = requeue.get(threadId) ?? [];
    const bytes = (requeueBytes.get(threadId) ?? 0) + line.length;
    if (queue.length >= MAX_REQUEUE_PER_THREAD || bytes > MAX_REQUEUE_BYTES_PER_THREAD) return; // 风暴丢行：重发可重试（无应答悬挂——retiring 本就重评）
    queue.push(line);
    requeue.set(threadId, queue);
    requeueBytes.set(threadId, bytes);
  }

  /** 在飞槽直接投递（命中即写——返回 false = 无槽需唤醒） */
  function deliverIfLive(threadId: string, line: string, info: { id?: string; type: string }): boolean {
    const slot = slotOf(threadId);
    if (slot === undefined) return false;
    deliverTo(slot.worker.uid, line, info);
    return true;
  }

  /** 占用容量 = 表内 live 域 + 在飞 @pending（start 应答未落实的 spawn） */
  function occupiedThreads(): number {
    let pending = 0;
    for (const id of byThread.keys()) {
      if (id.startsWith("@pending")) pending += 1;
    }
    return deps.table.liveCount() + pending;
  }

  function beginThread(line: string, trusted: boolean, cwd: string): { ok: true } | { ok: false; reason: string } {
    if (occupiedThreads() >= deps.limits.maxThreads) {
      return { ok: false, reason: "too many live threads (limit reached)" };
    }
    pendingSeq += 1;
    const pendingId = `@pending-${pendingSeq}`;
    const slot = spawnSlot(pendingId, trusted, cwd);
    deliverTo(slot.worker.uid, line, pendingCommandInfo(line));
    if (occupiedThreads() > deps.limits.maxThreads) {
      // 复验（并发竞窗兜底）：杀最新 slot——close 结算对 pending 补恰一 failure
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
    if (inflight !== undefined) return inflight; // 单飞守卫：并发 wake 复用首飞
    const flight = wakeOnce(threadId).finally(() => waking.delete(threadId));
    waking.set(threadId, flight);
    return flight;
  }

  async function wakeOnce(threadId: string): Promise<boolean> {
    const entry = deps.table.get(threadId);
    if (entry === undefined || entry.sessionPath === null) return false;
    if (deps.table.liveCount() >= deps.limits.maxThreads) return false;
    if (slotOf(threadId) !== undefined) return true;
    // 有界重试（1s × 12 拍）：覆盖 spawn/IO 瞬态失败（会话锁接管是即时的——
    // 内核判据 = 持锁 pid 活性；pid 复用误判存活属安全侧失败面，如实可观察）
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await Bun.sleep(1_000);
      deps.table.update(threadId, { state: "spawning" });
      const slot = spawnSlot(threadId, entry.trusted, entry.cwd);
      const internalId = nextInternalId();
      const verdict = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        let settled = false;
        const finish = (ok: boolean, reason?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ ok, ...(reason !== undefined ? { reason } : {}) });
        };
        // internal resume 死线：心跳存活但装配挂死的 worker 不得永久悬挂唤醒——
        // 超时按失败结算（kill 由下方失败路径执行）
        const deadline = setTimeout(() => finish(false, "resume deadline exceeded"), WORKER_SPAWN_TIMEOUT_MS);
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
      process.stderr.write(`hub: wake resume failed (attempt ${attempt + 1}): ${verdict.reason ?? "unknown"}\n`);
      slot.worker.kill(FORK_GRACE_SIGTERM_MS);
      await Promise.race([slot.worker.exited, Bun.sleep(FORK_GRACE_SIGTERM_MS + 1_000)]);
      if (deps.table.get(threadId) === undefined) return false; // 表项已亡（外部删除）
      if (deps.table.get(threadId)?.state === "parked") return false; // 窗口内被收编
    }
    // 重试耗尽：终态落 dead（spawning 滞留会永久占预算/挡 resume/逐不出；dead
    // 可被下一次写命令复活重试）
    process.stderr.write(`hub: wake retries exhausted (${threadId})\n`);
    deps.table.update(threadId, { state: "dead" });
    return false;
  }

  /** 行解析：坏 JSON → parse failure（唯一不带 id 的 failure 面；细节进 stderr） */
  function parseRouteLine(line: string): { id: string | undefined; type: string; threadId: string } | undefined {
    let input: { type?: unknown; id?: unknown; threadId?: unknown };
    try {
      input = JSON.parse(line) as { type?: unknown; id?: unknown; threadId?: unknown };
    } catch (error) {
      process.stderr.write(`hub: pool parse failure: ${String(error)}\n`);
      emitFailure(undefined, "parse", "parse failure");
      return undefined;
    }
    return {
      type: typeof input.type === "string" ? input.type : "",
      id: typeof input.id === "string" ? input.id : undefined,
      threadId: typeof input.threadId === "string" ? input.threadId : "",
    };
  }

  async function routeLine(line: string): Promise<void> {
    const parsed = parseRouteLine(line);
    if (parsed === undefined) return;
    const { id, type, threadId } = parsed;
    if (id !== undefined && id.startsWith(INTERNAL_ID_PREFIX)) {
      // internal 命名空间不可冒用：客户端 id 侵入会使响应被误判为内部 ack——
      // 不转发、恰一 failure
      emitFailure(id, type, "invalid id: reserved namespace");
      return;
    }
    if (!isThreadScoped(type) && !HOST_RELAYED_THREAD_COMMANDS.has(type)) {
      emitFailure(id, type, "unknown command");
      return;
    }
    if (threadId === "") {
      emitFailure(id, type, "threadId required");
      return;
    }
    const entry = deps.table.get(threadId);
    if (entry === undefined) {
      emitFailure(id, type, "Unknown threadId");
      return;
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
    emitFailure(id, type, "Unknown threadId");
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
      if (entry.state === "spawning") return "in-flight"; // wake 重试在飞——不 ack（防复活）
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
      // live 未落盘（首条消息前）同样拒绝（DESIGN §3.1 lazy-persist 拒绝——不能
      // 只挡非 live 面）
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
      // stop 优先于 retire：升级意图——close 按 stop 删表；retire 已 eof（stdin
      // 关闭），stop 命令无从投递，由拆除死线收口
      slot.retireIntent = "stop";
      deps.table.update(threadId, { retireIntent: "stop" });
    }
    return "ok";
  }

  function killStale(threadId: string): void {
    slotOf(threadId)?.worker.kill(FORK_GRACE_SIGTERM_MS);
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
    slotOf,
    retireThread,
    killStale,
    liveThreadIds,
    table: deps.table,
    shutdownAll,
  };
}

export type WorkerPool = ReturnType<typeof createWorkerPool>;
