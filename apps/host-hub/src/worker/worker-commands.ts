// 线程域命令注册表（DESIGN §3）：写侧命令；thread/start|resume|stop 在
// thread-commands.ts、读侧在 worker-read-commands.ts、thinking/permission 在
// worker-meta-commands.ts（注册表此处组装）。全部 failure 路径单点经 respond——
// failure 只构建未 emit 的零响应悬挂是历史缺陷族（B-H1/H2/M3/M4）的回归面。
// 语义映射：prompt 空闲 = agent.followup（受理即应答 fire-and-accept；收敛经
// settled）；流式 = steer/followup 纯文本降级；直写会话（信封/dial/thinking/
// title/permission-mode/clear）一律 append+flush。
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
  /** 装配目录快照（set_model/thinking 校验面） */
  catalog: WorkerCatalog;
  /** 装配拨号（dial 双源折叠的回落输入——仅 applyAssembly 更新，非运行期旁路） */
  dial: DialFact;
  /** 装配 AgentOptions.thinking 物化值（thinking 尾值缺省时的 fallback） */
  thinking: ThinkingLevel | undefined;
  /** 会话内权限档即时切句柄（装配期经 permissionMode 服务接线） */
  permissionService: PermissionModeService | undefined;
  /** 命令注册面（装配期捕获——prompt 分路与 compact 薄壳消费；fork/stop 随 world 失效） */
  commands: import("@x-harness/commands").CommandRegistry | undefined;
  /** 子代理面（delegationView——abort 级联与读口消费） */
  delegation: DelegationView | undefined;
  threadId: string;
  sessionPath: string;
  cwd: string;
  trusted: boolean;
  /** skills 目录快照（get_commands 目录面） */
  skillsDirs: readonly string[];
  skillsDisabled: ReadonlySet<string>;
  /** script 模式适配器（测试断言面） */
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
  /** 替换中途失败的自退（host 将见 close → thread_died） */
  triggerShutdown: () => void;
  env: Record<string, string | undefined>;
  /** 在飞 send 计数（受理窗口判据——turn/start 事件到达前 prompt 双发不竞态） */
  pendingSends: number;
  /** thinking 回退快照（装配期分级定值 + 来源——get 回退读此快照而非现算文件） */
  thinkingFallback?: { level: ThinkingLevel; source: "project" | "user" } | undefined;
  /** permission 回退来源快照（WAL 无会话档时 get_mode 的四态 source） */
  permissionModeSource?: "project" | "user" | "default" | undefined;
}

export type CommandInput = { id?: string; [key: string]: unknown };
export type Handler = (input: CommandInput) => Promise<void>;

/** respond 目标面：id + 命令名 + 单选 data|error（id-first key 序单点——worker 全部
 *  响应必经此处，type-first 内联字面量会绕过 host 对账核销） */
export interface ResponseTarget {
  id: string | undefined;
  command: string;
  data?: unknown;
  error?: HubErrorShape;
}

/** 响应单点（failure 必 emit） */
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

/** 当前会话（线程守卫后的读口糖） */
export function sessionOf(rt: WorkerRuntime): Session | undefined {
  return rt.state.handle?.agent.session;
}

/** 线程守卫：无会话/单会话 id 不符 → failure 应答（fork 重键在飞旧 id 的结算面） */
export function requireThread(rt: WorkerRuntime, input: { id?: string; threadId?: unknown; command?: string }): Session | undefined {
  const session = sessionOf(rt);
  if (session === undefined || rt.state.threadId === "") {
    respond(rt, { id: input.id, command: input.command ?? "", error: hubError("unknown_thread", "Unknown threadId") });
    return undefined;
  }
  if (input.threadId !== undefined && input.threadId !== rt.state.threadId) {
    // 单会话守卫（fork 重键在飞旧 id 命令由此结算）——同串分码：superseded 禁重锚自愈
    respond(rt, { id: input.id, command: input.command ?? "", error: hubError("thread_superseded", "Unknown threadId") });
    return undefined;
  }
  return session;
}

/** 同步处理器包装：保持注册表 Promise 契约（同步抛错按 async 语义转拒绝——
 *  命令循环的 hub_error 兜底面不因去 async 而炸进程） */
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

/** images 校验（单点 = shared/normalizeImages）：形状 + 量限（单图/张数/总量）——
 *  code 由单点携带（形状 → invalid_input / 量限 → images_too_many） */
function parseImages(value: unknown): { ok: true; images: WireImage[] | undefined } | { ok: false; code: "invalid_input" | "images_too_many"; reason: string } {
  return normalizeImages(value);
}

/** images 能力门：携图时按当前 dial（双源折叠）查模型输入模态——不含 image 即拒
 *  （防上游 openai 协议把图静默降级为占位文本；BATCH2-DESIGN §1.1） */
function imagesGate(rt: WorkerRuntime, images: WireImage[] | undefined): string | undefined {
  if (images === undefined) return undefined;
  const session = rt.state.handle?.agent.session;
  const dial = session !== undefined ? currentDialOf(session.events(), rt.state.dial) : rt.state.dial;
  return imagesUnsupported(rt.state.catalog, dial);
}

/** WireImage（wire 形状）→ Agent face images 选项（字段同形直传） */
function imageOptions(images: WireImage[] | undefined): { images: readonly ImageBlock[] } | undefined {
  return images === undefined ? undefined : { images: [...images] };
}

/** delegation 投递失败族映射（agent-delegation reason 前缀词表对拍）：寻址/参数
 *  → invalid_input（无会话文件重锚面——不得误用 unknown_thread 触发自愈）、
 *  not-live → thread_not_live、busy 容量 → thread_limit、其余 → internal 原文保留 */
function delegationError(reason: string): HubErrorShape {
  if (reason.startsWith("invalid-args:") || reason.startsWith("not-found:") || reason.startsWith("not-owner:")) return hubError("invalid_input", reason);
  if (reason.startsWith("not-live:")) return hubError("thread_not_live", reason);
  if (reason.startsWith("busy:")) return hubError("thread_limit", reason);
  return hubError("internal", reason);
}

/** settled 收敛面：kick 时打事件长度标记，whenIdle 后扫描新区间的 turn/end——
 *  error/blocked 收敛 → ok:false（否则 ok:true）；abort/clear 不取消 settled。
 *  受理记账（pendingSends +1）在登记成功时同步进行：无 id 的 driving 命令无从
 *  关联 settled、也就无人减账——不入账，否则受理窗口（pendingSends>0）永久敞开。 */
export function settleAfter(rt: WorkerRuntime, id: string | undefined): boolean {
  if (id === undefined) return false; // 无 id 无从关联——不发 settled
  const handle = rt.state.handle;
  if (handle === undefined) return false;
  const threadIdAtKick = rt.state.threadId; // fork 替换后旧输入的 settled 仍按 kick 时线程盖章
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

/** 命令分路（BATCH3-DESIGN §2.4）：内核 execute 未命中 → false（调用方走原路径——
 *  未注册词形交模型）；命中 → 恰一应答（成功 data = 结果结构化载荷三元组、error =
 *  result.text 既有词表串；throw 同步 catch 应答——零响应悬挂防线）。signal = inflight
 *  登记面（abort 命令/优雅关停经此穿透到 runner，归一串 compaction aborted 不变） */
async function dispatchCommand(
  rt: WorkerRuntime,
  input: CommandInput,
  spec: { command: string; line: string; imagesPresent: boolean },
): Promise<boolean> {
  const registry = rt.state.commands;
  if (registry === undefined) return false;
  const session = sessionOf(rt);
  if (session === undefined) return false;
  // 携图命中命令 → 既有拒绝串（命令面不收附件；分路序：形状/量限/能力门已在前）
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
      // compact 命令词表（packages/compaction 内层穿透）统一 compact_rejected
      respond(rt, { id: input.id, command: spec.command, error: hubError("compact_rejected", execution.result.text) });
    } else {
      respond(rt, { id: input.id, command: spec.command, data: execution.result.data });
    }
    return true;
  } catch (error) {
    // 异常必应答（恰一响应铁律——execute 重抛态）
    respond(rt, { id: input.id, command: spec.command, error: errorOfCause(error) });
    return true;
  } finally {
    registration.unregister();
  }
}

/** prompt 流式分支（turn 在飞 ∨ send 在飞）：steer/followup 投递（携图同投——
 *  单 entry 同轮消费；不经命令词法——声明性降级） */
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
    // kick 同步抛错：未受理——failure 应答（无 settled 义务）
    respond(rt, { id: input.id, command: "prompt", error: errorOfCause(error) });
    return;
  }
  respond(rt, { id: input.id, command: "prompt" });
  settleAfter(rt, input.id);
}

/** fork 入参校验（单点错误面）：流式互斥/seq 词法（0 基）/边界/首事件前——
 *  越过 durable 边界 = 调用方游标过期（cursor_stale，消费方重取 leafSeq） */
export function forkInputVerdict(rt: WorkerRuntime, lastSeq: number, input: CommandInput): HubErrorShape | undefined {
  if (rt.bridge.isStreaming()) return hubError("streaming_window", "thread is streaming");
  const seq = input.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return hubError("invalid_input", `invalid fork seq: ${String(seq)}`);
  if (seq > lastSeq) return hubError("cursor_stale", "fork beyond durable boundary");
  if (input.position !== "at" && seq === 0) return hubError("invalid_input", "fork before first event"); // 首事件前无可保留内容
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
    // 命令分路（现状序保持：先于流式判定——流式中 /compact 经 busy 前置收 thread is streaming）
    const dispatched = await dispatchCommand(rt, input, { command: "prompt", line: message, imagesPresent: input.images !== undefined });
    if (dispatched) return;
    // 流式判定 = turn 在飞 ∨ send 在飞（受理窗口：response 已发而 turn/start 未达
    // 的窗口内双发 prompt 不走 send 竞态）
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
      agent.followup(message, imageOptions(parsedImages.images)); // kick 同步（先 kick 后应答——全路径恰一响应）
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
    settleAfter(rt, input.id); // 受理窗口覆盖（与 prompt 全路径同口径）

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
    await rt.inflight.abortAll(); // 手动压缩 per-call signal 联动
    if (rt.state.delegation !== undefined) {
      await rt.state.delegation.stopAll(session.id, "client-abort");
    }
    rt.state.handle?.agent.cancel("client-abort");
    respond(rt, { id: input.id, command: "abort" });
  });

  handlers.set("clear_queue", async (input) => {
    const session = requireThread(rt, { ...input, command: "clear_queue" });
    if (session === undefined) return;
    const before = foldQueue(session.events()); // 先取后清——返回被清文本
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

  // 单条队列命令寻址键 = entryId（inbox entry id，get_state.queue 投影携带；命令 id
  // 字段是请求回执 id，两者不同名）。未知 entryId 按 state_conflict 拒绝（已消费/
  // 已清空的竞态，消费方自行收敛），不重放队列镜像。
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

  // 立即改向：next-turn 条目 retarget 进 next-step——运行中轮的下一步边界领取注入；
  // 轮若在命令到达前已收尾，retarget 后的 next-step 存货由链式条件兜底（step0 领取），
  // 空闲且无在飞 send 时无轮可改向，按受理窗口族拒绝（条目留在 followUp 队列不动）。
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
    if (!dispatched) respond(rt, { id: input.id, command: "compact", error: hubError("unknown_command", "unknown command") }); // 无命令面装配的防御分支（hub 恒装配）
  });

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
    // 换 provider/model，thinking 原样保留（不清档）；保留档 × 目标不兼容 → 写前拒
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

  // ui_response：弹窗应答路由进 broker（未知/晚到静默忽略）。无 response 帧——
  // host 对客户端恒 ack，worker 侧重复应答会破坏恰一响应
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
    // 驻留即投递：running → 步边界排队 / idle → 唤醒开新轮（内核 agent_message 语义）
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
