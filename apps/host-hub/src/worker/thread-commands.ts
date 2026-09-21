// 线程生命周期命令（DESIGN §3.1）：thread/start（新会话装配）/ thread/resume
// （WAL 恢复——cwd 回退序：显式入参 > 会话头 header.cwd > worker 现值）/ thread/stop
// （dispose + 自清）。装配公共腿（assembleThread）为 start/resume/fork 共用面。
// 会话级设置初值（DESIGN §3.9）：permission mode = 显式入参 > WAL 尾值 > 项目级
// （trusted）> hub-settings 默认；thinking level = 显式入参 > WAL 尾值。显式入参 =
// append session/meta 覆盖（不静默压制）；controller 后置到 flush 成功（报失败但
// 提权是最坏方向）。
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSafeSessionId, mintSessionId } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import type { ThinkingLevel } from "@x-harness/llm";
import { permissionMode as permissionModeToken } from "@x-harness/permission";
import { delegationView } from "@x-harness/agent-delegation";
import { commandRegistry } from "@x-harness/commands";
import { assembleWorkerAgent, teardownWorld } from "./assembly.ts";
import type { AssemblyResult } from "./assembly.ts";
import { forkInputVerdict, respond, requireThread, sessionOf } from "./worker-commands.ts";
import type { CommandInput, Handler, WorkerRuntime, WorkerState } from "./worker-commands.ts";
import type { EventBridge } from "./event-bridge.ts";
import { PERMISSION_MODES, THINKING_LEVELS, thinkingUnsupported } from "./meta-state.ts";
import { META_KEY_PERMISSION, META_KEY_THINKING } from "./meta-state.ts";
import { foldDial, metaTailOf } from "../shared/meta-fold.ts";
import { mergeSettings, normalizeCwd, projectSettingsPath, readHubSettings, readProjectSettings } from "../shared/settings-store.ts";
import type { HubSettings } from "../shared/settings-store.ts";

/** worker 侧信任判定（数据通路）：只读注册表文件 ∪ 自身 state.trusted——注册表只
 *  服务持久条目，自有 start 场景由 state 兜底（无竞态） */
export async function workspaceTrusted(agentDir: string, cwd: string, selfTrusted: boolean): Promise<boolean> {
  if (selfTrusted) return true;
  const normalized = await normalizeCwd(cwd);
  try {
    const raw = await readFile(join(agentDir, "trusted-workspaces.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.some((item) => typeof item === "string" && item === normalized);
  } catch {
    return false; // 缺席/坏文件 fail-closed
  }
}

/** 分级设置读取：cwd ∈ 信任集时项目并入。返回合并值 + 来源事实（单次读取——
 *  快照语义无二次窗口） */
async function effectiveSettings(agentDir: string, cwd: string, trusted: boolean): Promise<{ values: HubSettings; user: HubSettings; projectHit: boolean }> {
  const user = await readHubSettings(agentDir);
  const projectHit = await workspaceTrusted(agentDir, cwd, trusted);
  if (!projectHit) return { values: user, user, projectHit };
  const project = await readProjectSettings(cwd);
  return { values: mergeSettings(user, project).values, user, projectHit };
}

interface SessionParams {
  paramMode: "plan" | "auto" | "full" | undefined;
  paramLevel: string | undefined;
}

interface SessionParamsInput {
  permissionMode?: unknown;
  thinkingLevel?: unknown;
  trusted?: unknown;
  [key: string]: unknown;
}

/** 会话设置入参束（thread/start|resume 可选参） */
function settingsParamsOf(input: SessionParamsInput): SessionParams {
  const rawMode = input.permissionMode;
  const rawLevel = typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined;
  return {
    // 词表外的垃圾入参静默降级（不落盘——与 thinkingLevel 同口径）
    paramMode: typeof rawMode === "string" && PERMISSION_MODES.includes(rawMode) ? (rawMode as "plan" | "auto" | "full") : undefined,
    paramLevel: rawLevel !== undefined && THINKING_LEVELS.includes(rawLevel as ThinkingLevel) ? rawLevel : undefined,
  };
}

/** resume 装配前的 cwd 预读：x-harness 会话头独立 header.json——直读（缺头/坏头
 *  返回 undefined，仅用户级设置） */
async function preReadCwd(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(sessionsRoot, sessionId, "header.json"), "utf8");
    const parsed = JSON.parse(raw) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** 装配结果接线进 runtime（state 落实 + 事件桥 wire + 服务捕获） */
interface AssemblyTarget {
  rt: { state: WorkerState; bridge: EventBridge };
  assembled: AssemblyResult;
  cwd: string;
  sessionsRoot: string;
}

function applyAssembly(target: AssemblyTarget): void {
  const { rt, assembled, cwd, sessionsRoot } = target;
  rt.state.handle = assembled.handle;
  rt.state.world = assembled.world;
  rt.state.catalog = assembled.catalog;
  rt.state.dial = assembled.dial;
  rt.state.thinking = assembled.thinking;
  rt.state.threadId = assembled.sessionId;
  rt.state.sessionPath = join(sessionsRoot, assembled.sessionId, "events.jsonl");
  rt.state.cwd = cwd;
  rt.state.skillsDirs = assembled.skillsDirs;
  rt.state.skillsDisabled = assembled.skillsDisabled;
  rt.state.scriptAdapter = assembled.scriptAdapter;
  rt.state.permissionService = assembled.world.ctx.tryUse(permissionModeToken);
  rt.state.delegation = assembled.world.ctx.tryUse(delegationView);
  rt.state.commands = assembled.world.ctx.tryUse(commandRegistry);
  rt.bridge.wire(assembled.world.ctx);
}

/** 装配公共腿（start/resume/fork 共用）：hub-settings 快照 + ask 桥 + 权限初值 +
 * cwd 取值回调 */
export async function assembleThread(rt: WorkerRuntime, plan: {
  fields: import("./assembly.ts").AssemblyFields;
  input: SessionParamsInput;
  cwdOf: (assembled: AssemblyResult) => string;
  sessionsRoot?: string;
  cwdHint?: string;
}): Promise<void> {
  const cwdHint = plan.cwdHint ?? plan.fields.cwd ?? process.cwd();
  const selfTrusted = rt.state.trusted || plan.input.trusted === true;
  const { values: settings, user: userFile, projectHit } = await effectiveSettings(rt.agentDir, cwdHint, selfTrusted);
  applyFallbackSnapshots(rt, { settings, userFile, projectHit });
  const params = settingsParamsOf(plan.input);
  const initialMode = params.paramMode ?? settings["permission.defaultMode"] ?? "auto";
  const assembled = await assembleWorkerAgent({
    ...plan.fields,
    confirm: (fields) => rt.broker.confirm(rt.state.threadId === "" ? "unassigned" : rt.state.threadId, fields),
    ...(settings["thinking.default"] !== undefined ? { thinkingDefault: settings["thinking.default"] } : {}),
    permissionMode: initialMode,
    ...(settings["skills.disabled"] !== undefined ? { skillsDisabled: settings["skills.disabled"] } : {}),
  });
  // 写前校验前置到接线前：拒绝发生在 state 落位之前——命令失败不残留半开线程
  const paramLevel = params.paramLevel;
  if (paramLevel !== undefined) {
    const unsupported = thinkingUnsupported(assembled.catalog, assembled.dial, paramLevel as ThinkingLevel);
    if (unsupported !== undefined) {
      await assembled.handle.dispose().catch(() => undefined);
      await teardownWorld(assembled.world);
      throw new Error(`thinkingLevel rejected: ${unsupported}`);
    }
  }
  applyAssembly({ rt, assembled, cwd: plan.cwdOf(assembled), sessionsRoot: rt.sessionsRoot });
  await applySessionSettings(rt, { params });
}

/** 回退快照（live 锚定）：来源按「用户级值 vs 合并值 + 项目命中」（单次读取事实；
 *  项目与用户同值时标 user——值等展示无差） */
function applyFallbackSnapshots(rt: WorkerRuntime, files: { settings: HubSettings; userFile: HubSettings; projectHit: boolean }): void {
  rt.thinkingFallback = files.settings["thinking.default"] !== undefined
    ? {
        level: files.settings["thinking.default"],
        source: files.userFile["thinking.default"] !== files.settings["thinking.default"] && files.projectHit ? "project" : "user",
      }
    : undefined;
  const mergedMode = files.settings["permission.defaultMode"];
  const userMode = files.userFile["permission.defaultMode"];
  if (mergedMode !== undefined && mergedMode !== userMode && files.projectHit) rt.permissionModeSource = "project";
  else if (userMode !== undefined) rt.permissionModeSource = "user";
  else rt.permissionModeSource = "default";
}

/** 装配后置：WAL 尾值补位/显式入参覆盖——start/resume 共用。直写纪律：append 必
 *  flush；service.set 后置到 flush 成功（持久层与即时层同终值）。 */
async function applySessionSettings(rt: WorkerRuntime, fields: { params: SessionParams }): Promise<void> {
  const session = sessionOf(rt);
  if (session === undefined) return;
  const events = session.events();
  const walModeValid = permissionOf(metaTailOf(events, META_KEY_PERMISSION));
  if (fields.params.paramMode !== undefined && fields.params.paramMode !== walModeValid) {
    const append = session.append("session/meta", { key: META_KEY_PERMISSION, value: fields.params.paramMode });
    if (!append.ok) throw new Error(append.reason);
  }
  if (fields.params.paramLevel !== undefined) {
    // 入参成为新尾值即胜过既有尾值，且持久化（与 permission 的 append 语义对称）
    const append = session.append("session/meta", { key: META_KEY_THINKING, value: fields.params.paramLevel });
    if (!append.ok) throw new Error(append.reason);
  }
  const flushed = await rt.state.world?.store.flush(session.id);
  if (flushed !== undefined && !flushed.ok) throw new Error(flushed.reason);
  // 即时切档后置到持久化成功；WAL 尾值 > 入参（入参已 append——终值即入参）
  const finalMode = fields.params.paramMode ?? walModeValid;
  if (finalMode !== undefined) rt.state.permissionService?.set(finalMode);
}

function permissionOf(value: unknown): "plan" | "auto" | "full" | undefined {
  return typeof value === "string" && PERMISSION_MODES.includes(value) ? (value as "plan" | "auto" | "full") : undefined;
}

/** resume cwd 回退序：显式入参 > 会话头（header.cwd——未带 cwd 时工作区锚定按
 *  会话事实恢复，不落 host 进程 cwd）> worker 现值 */
export function resumeCwdOf(input: { cwd?: unknown; [key: string]: unknown }, assembled: AssemblyResult, fallback: string): string {
  if (typeof input.cwd === "string" && input.cwd !== "") return input.cwd;
  return assembled.handle.agent.session.header.cwd ?? fallback;
}

/** fork/clone 共享体（DESIGN §3.5）：校验 → flush → store.fork（返回已打开会话——
 * 取 id 后即 dispose 释放写锁）→ 拆旧装配新（串行域）。重装配失败 = 替换中途
 * 失败 → failure + 自退（host 见 close → thread_died）。 */
export async function doFork(rt: WorkerRuntime, input: CommandInput, command: string): Promise<void> {
  const session = requireThread(rt, { ...input, command });
  const world = rt.state.world;
  if (session === undefined || world === undefined) return;
  const events = session.events();
  const invalid = forkInputVerdict(rt, events.length - 1, input);
  if (invalid !== undefined) {
    respond(rt, { id: input.id, command, error: invalid });
    return;
  }
  const position = input.position === "at" ? "at" : "before";
  const seq = input.seq as number; // 校验已过
  // durable 边界对齐：内存尖 append（通知注入等 fire-and-forget 路径）会使 clone
  // 撞 fork-beyond-durable 且报误导文案——fork 前先冲刷
  const flushed = await world.store.flush(session.id);
  if (!flushed.ok) {
    respond(rt, { id: input.id, command, error: flushed.reason });
    return;
  }
  const previousThreadId = rt.state.threadId;
  const untilSeq = position === "at" ? seq : seq - 1;
  const currentDial = foldDial(events.slice(0, untilSeq + 1), rt.state.dial); // 前缀拨号（截断域折叠——cut 后的 set_model 不泄漏）
  const forked = await world.store.fork(session.id as SessionId, { untilSeq, id: mintSessionId() });
  if (!forked.ok) {
    respond(rt, { id: input.id, command, error: `invalid fork seq: ${forked.reason}` });
    return;
  }
  const newId = forked.value.id;
  // fork 返回的是已打开会话（持写锁）——取 id 后即关，重装配走 resume 路径
  const disposed = world.store.dispose(newId);
  if (!disposed.ok) {
    respond(rt, { id: input.id, command, error: `fork reassembly failed: ${disposed.reason}` });
    return;
  }
  // 拆除序（BATCH2 §3）：stopAll 先于 unsubscribe——fork 重装配期子的 finished 边沿可达
  if (rt.state.delegation !== undefined && rt.state.handle !== undefined) {
    await rt.state.delegation.stopAll(rt.state.handle.agent.session.id, "fork-reassembly");
  }
  rt.bridge.unsubscribe();
  await rt.state.handle?.dispose();
  await teardownWorld(world);
  rt.state.handle = undefined;
  rt.state.world = undefined;
  rt.state.permissionService = undefined; // 旧服务随 world 失效——防悬挂
  rt.state.delegation = undefined;
  rt.state.commands = undefined;
  try {
    // 重装配走公共腿（与 start/resume 同构）：dial 挂点/permission 服务/skills
    // 快照全接线；fork 前缀自带 session/meta → WAL 尾值天然继承
    await assembleThread(rt, {
      fields: {
        sessionsRoot: rt.sessionsRoot,
        cwd: rt.state.cwd,
        trusted: rt.state.trusted,
        resumeId: newId,
        dial: currentDial,
        env: rt.env,
      },
      input: {},
      cwdOf: () => rt.state.cwd,
    });
  } catch (error) {
    process.stderr.write(`hub:worker: fork reassembly failed: ${String(error)}\n`);
    respond(rt, { id: input.id, command, error: `fork reassembly failed: ${String(error instanceof Error ? error.message : error)}` });
    rt.triggerShutdown();
    return;
  }
  respond(rt, {
    id: input.id,
    command,
    data: { threadId: newId, previousThreadId, sessionPath: rt.state.sessionPath },
  });
}

/** 生命周期互斥（审查 cM1）：thread/start|resume|stop|fork|clone 串行——stop 与
 *  在飞 fork 的 dispose/重装配不再交错；其余命令不受影响 */
let lifecycleChain: Promise<void> = Promise.resolve();

export function serializedLifecycle(run: () => Promise<void>): Promise<void> {
  const task = lifecycleChain.then(run);
  lifecycleChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function serialized(handler: Handler): Handler {
  return (input) => {
    const run = lifecycleChain.then(() => handler(input));
    lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function registerThreadCommands(rt: WorkerRuntime, handlers: Map<string, Handler>): void {
  handlers.set("thread/start", async (input) => {
    if (rt.state.handle !== undefined) {
      respond(rt, { id: input.id, command: "thread/start", error: "already open" });
      return;
    }
    try {
      // cwd 归一：header.cwd 是 list_saved{cwd} 全等匹配的基准——尾斜杠/symlink
      // 拼法分叉会漏会话；与信任链 normalizeCwd 同口径
      const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
      const cwd = await normalizeCwd(rawCwd);
      const trusted = input.trusted === true;
      const modelId = typeof input.modelId === "string" ? input.modelId : undefined;
      await assembleThread(rt, {
        fields: {
          sessionsRoot: rt.sessionsRoot,
          cwd,
          trusted,
          ...(modelId !== undefined ? { modelId } : {}),
          env: rt.env,
        },
        input,
        cwdOf: () => cwd,
      });
      rt.state.trusted = trusted;
      // 信任引导（DESIGN §3.9）：仅非信任（入参与注册表均未命中）且项目设置文件
      // 存在 → 提示
      let projectSettingsPresent: boolean | undefined;
      if (!(trusted || (await workspaceTrusted(rt.agentDir, cwd, false)))) {
        projectSettingsPresent = await readFile(projectSettingsPath(cwd)).then(
          () => true,
          () => false,
        );
      }
      respond(rt, {
        id: input.id,
        command: "thread/start",
        data: {
          threadId: rt.state.threadId,
          cwd,
          sessionPath: rt.state.sessionPath,
          ...(projectSettingsPresent === true ? { projectSettingsPresent: true } : {}),
        },
      });
    } catch (error) {
      respond(rt, { id: input.id, command: "thread/start", error: String(error instanceof Error ? error.message : error) });
    }
  });

  handlers.set("thread/resume", async (input) => {
    if (rt.state.handle !== undefined) {
      respond(rt, { id: input.id, command: "thread/resume", error: "already open" });
      return;
    }
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    const resumeId = sessionPath.split("/").at(-2) ?? "";
    if (!isSafeSessionId(resumeId)) {
      respond(rt, { id: input.id, command: "thread/resume", error: "Session file not readable" });
      return;
    }
    try {
      // hub 预检：档案在场性（header + events 文件存在；空 events = 合法空会话——
      // 内核 create 先落 header、事件随首条 append；撕裂末行由内核恢复器处理）
      const eventsFile = join(rt.sessionsRoot, resumeId, "events.jsonl");
      const headerFile = join(rt.sessionsRoot, resumeId, "header.json");
      const eventsExists = await stat(eventsFile).then(() => true, () => false);
      const headerExists = await stat(headerFile).then(() => true, () => false);
      if (!eventsExists || !headerExists) {
        respond(rt, { id: input.id, command: "thread/resume", error: "Session file not readable" });
        return;
      }
      const trusted = input.trusted === true;
      // 装配前预读 cwd（项目档分级依赖——读不到仅用户级）
      const explicitCwdRaw = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
      const explicitCwd = explicitCwdRaw !== undefined ? await normalizeCwd(explicitCwdRaw) : undefined;
      const cwdHint = explicitCwd ?? (await preReadCwd(rt.sessionsRoot, resumeId)) ?? rt.state.cwd;
      await assembleThread(rt, {
        fields: {
          sessionsRoot: rt.sessionsRoot,
          // cwd 回退序全链生效（fence/toolbox/trusted 目录根——worker 进程 cwd 不得渗入）
          cwd: explicitCwd ?? cwdHint,
          trusted,
          resumeId,
          env: rt.env,
        },
        input,
        cwdOf: (assembled) => resumeCwdOf(input, assembled, cwdHint),
        cwdHint,
      });
      rt.state.trusted = trusted;
      respond(rt, {
        id: input.id,
        command: "thread/resume",
        data: { threadId: rt.state.threadId, cwd: rt.state.cwd, sessionPath: rt.state.sessionPath },
      });
    } catch (error) {
      respond(rt, { id: input.id, command: "thread/resume", error: `cannot resume session: ${String(error instanceof Error ? error.message : error)}` });
    }
  });

  handlers.set("thread/stop", serialized(async (input) => {
    const handle = rt.state.handle;
    if (handle !== undefined) {
      // 拆除序（BATCH2 §3，对齐 worker 优雅关停）：先 stopAll（桥在线——子的
      // agent/finished 边沿可达客户端）→ 再 unsubscribe → 再 teardown（级联期
      // tearing-down 门挡回 notifier，先拆桥会吞掉全部 finished 事件）
      if (rt.state.delegation !== undefined) {
        await rt.state.delegation.stopAll(handle.agent.session.id, "thread-stop");
      }
      rt.bridge.unsubscribe();
      await handle.dispose();
      if (rt.state.world !== undefined) await teardownWorld(rt.state.world);
      rt.state.handle = undefined;
      rt.state.world = undefined;
      rt.state.threadId = "";
      rt.state.sessionPath = "";
      rt.state.permissionService = undefined;
      rt.state.delegation = undefined;
  rt.state.commands = undefined;
    }
    respond(rt, { id: input.id, command: "thread/stop" });
  }));
}
