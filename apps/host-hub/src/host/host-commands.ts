// host 本地命令（DESIGN §3）：线程生命周期准入（围栏/占用/预算）、模型目录与
// overrides、凭据、宿主信息与旋钮、agents/list、ui_response 广播。非本集且非线程域
// → unknown command（池侧统一拒）；缺 threadId 由池侧判（线程域命令）。
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadAgentTypes } from "@x-harness/agent-delegation";
import { responseFrame } from "../protocol/frames.ts";
import { clampIdleRetireMs, clampRssRetireBytes, DIRECT_READ_MAX_BYTES } from "../shared/limits.ts";
import type { WorkerPool } from "./worker-pool.ts";
import type { ThreadTable } from "./thread-table.ts";
import { fenceSessionPath } from "./read-history.ts";
import type { DirectRead } from "./read-history.ts";
import { deleteSession } from "./session-delete.ts";
import { listSavedSessions } from "./saved-query.ts";
import { normalizeCwd } from "../shared/settings-store.ts";
import { PARKED_DIRECT_COMMANDS, createParkedReads } from "./parked-reads.ts";
import { createModelsAuthCommands } from "./models-auth.ts";
import { builtinTypesDir } from "../worker/assembly.ts";
import { createAdminCommands } from "./admin-commands.ts";
import { createTrustStore } from "./trust-store.ts";
import type { TrustStore } from "./trust-store.ts";

export interface HostCommandsDeps {
  table: ThreadTable;
  pool: WorkerPool;
  direct: DirectRead;
  agentDir: string;
  sessionsRoot: string;
  limits: {
    maxThreads: number;
    idleRetireMs: number;
    workerStaleMs: number;
    workerExitTimeoutMs: number;
    rssRetireBytes: number;
    bashTimeoutMs: number;
  };
  setLimits: (patch: { idleRetireMs?: number; rssRetireBytes?: number }) => void;
  emitClient: (line: string) => void;
  startedAt: number;
  version: string;
}

export interface HostCommandContext {
  /** ui_response 广播给全部 live worker（恒 ack） */
  broadcastToWorkers: (line: string) => void;
  /** 凭据/目录变更后刷新 worker spawn 装配快照缓存（host.ts 持有缓存） */
  refreshSnapshot: () => Promise<void>;
}

/** host 本地命令处理器面（注册表按命令名一分派） */
type LocalHandler = (input: { type?: unknown; id?: unknown; [key: string]: unknown }, id: string | undefined) => Promise<void> | void;

/** 词法围栏（同步段）：绝对路径 + 布局 + id 词法 + **词法规范化**（别名拼法归一
 *  canonical 形——占用表键不可被 `./`、双斜杠等拼法绕过；realpath 复核在占位后） */
function shapeFence(sessionPath: string, sessionsRoot: string): { ok: true; threadId: string; sessionPath: string } | { ok: false; reason: string } {
  if (!sessionPath.startsWith("/")) {
    return { ok: false, reason: "session path outside sessions dir: absolute path required" };
  }
  const parts = sessionPath.split("/");
  const file = parts.at(-1);
  const id = parts.at(-2) ?? "";
  if (file !== "events.jsonl" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    return { ok: false, reason: "session path outside sessions dir: malformed layout" };
  }
  const canonical = join(sessionsRoot, id, "events.jsonl");
  if (sessionPath !== canonical) {
    // 词法别名（./、重复段、非规范顺序）——占用判定按 canonical 归一
    return { ok: true, threadId: id, sessionPath: canonical };
  }
  return { ok: true, threadId: id, sessionPath };
}

/** trusted:true 的注册表登记（start/resume/register 共用——host 转发链执行，
 *  worker 永不写注册表） */
function registerTrust(trust: TrustStore, input: { trusted?: unknown }, cwd: string): void {
  if (input.trusted === true) void trust.trust(cwd);
}

export function createHostCommands(deps: HostCommandsDeps, ctx: HostCommandContext) {
  function respond(id: string | undefined, command: string, result: { data?: unknown; error?: string }): void {
    deps.emitClient(
      responseFrame({
        ...(id !== undefined && id !== "" ? { id } : {}),
        command,
        success: result.error === undefined,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      }),
    );
  }
  const modelsAuth = createModelsAuthCommands({ agentDir: deps.agentDir, respond, emitClient: deps.emitClient, refreshSnapshot: ctx.refreshSnapshot });
  const credentials = modelsAuth.credentials;
  const trust = createTrustStore(deps.agentDir);
  const parkedReads = createParkedReads({ table: deps.table, direct: deps.direct, emitClient: deps.emitClient });

  /** thread/resume 占位段：词法围栏 + 有界等待释放 + 预算 + 表占位（先于复核段） */
  async function reserveResumeSlot(
    input: { [key: string]: unknown },
    id: string | undefined,
  ): Promise<{ ok: true; shape: { threadId: string; sessionPath: string } } | { ok: false }> {
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    // 同步段：词法围栏 + 占用声明——先于一切 await（消灭双开竞态窗口）；
    // realpath 围栏在占位后复核（失败撤位应答）
    const shape = shapeFence(sessionPath, deps.sessionsRoot);
    if (!shape.ok) {
      respond(id, "thread/resume", { error: shape.reason });
      return { ok: false };
    }
    // retiring/spawning 持有者：有界等待释放（stop/retire 在途的收尾是有界拆除）；
    // 超窗或稳定占用 → already open
    for (let waited = 0; waited < 12_000; waited += 250) {
      const holder = deps.table.holderOf(shape.sessionPath);
      if (holder === undefined) break;
      const holderEntry = deps.table.get(holder);
      if (holderEntry !== undefined && holderEntry.state === "dead") {
        // dead 表项无 live worker——resume 直接接管（复活可重试语义，DESIGN §7）
        deps.table.remove(holder);
        break;
      }
      if (holderEntry === undefined || (holderEntry.state !== "retiring" && holderEntry.state !== "spawning")) {
        respond(id, "thread/resume", { error: "already open" });
        return { ok: false };
      }
      await Bun.sleep(250);
    }
    const holderAfter = deps.table.holderOf(shape.sessionPath);
    if (holderAfter !== undefined) {
      respond(id, "thread/resume", { error: "already open" });
      return { ok: false };
    }
    if (deps.table.liveCount() >= deps.limits.maxThreads) {
      respond(id, "thread/resume", { error: "too many live threads (limit reached)" });
      return { ok: false };
    }
    const existing = deps.table.get(shape.threadId);
    if (existing !== undefined) {
      deps.table.update(shape.threadId, {
        state: "spawning",
        sessionPath: shape.sessionPath,
        trusted: input.trusted === true,
      });
    } else {
      deps.table.insert({
        threadId: shape.threadId,
        cwd: typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd(),
        sessionPath: shape.sessionPath,
        state: "spawning",
        trusted: input.trusted === true,
        keepalive: false,
      });
    }
    return { ok: true, shape };
  }

  /** thread/resume 复核段：realpath 圈内复核 + 存在性——失败撤位应答 */
  async function verifyResumeSlot(input: { [key: string]: unknown }, id: string | undefined, shape: { threadId: string; sessionPath: string }): Promise<void> {
    const fence = await fenceSessionPath(shape.sessionPath, deps.sessionsRoot);
    if (!fence.ok) {
      const current = deps.table.holderOf(shape.sessionPath);
      if (current === shape.threadId) deps.table.remove(shape.threadId);
      respond(id, "thread/resume", { error: fence.reason });
      return;
    }
    const exists = await stat(fence.sessionPath).then(
      () => true,
      () => false,
    );
    if (!exists) {
      const current = deps.table.holderOf(shape.sessionPath);
      if (current === shape.threadId) deps.table.remove(shape.threadId);
      respond(id, "thread/resume", { error: "Session file not readable" });
      return;
    }
    deps.pool.beginKnown(fence.threadId, JSON.stringify(input));
    const entry = deps.table.get(fence.threadId);
    if (entry !== undefined) registerTrust(trust, input, entry.cwd);
  }

  function handleThreadStart(input: { [key: string]: unknown }, id: string | undefined): void {
    const trusted = input.trusted === true;
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
    const verdict = deps.pool.beginThread(JSON.stringify(input), trusted, cwd);
    if (!verdict.ok) respond(id, "thread/start", { error: verdict.reason }); // 成功路径的响应经 worker 控制响应转发
    else registerTrust(trust, input, cwd); // 注册表登记（host 转发链）
  }

  async function handleThreadResume(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const reserved = await reserveResumeSlot(input, id);
    if (!reserved.ok) return;
    await verifyResumeSlot(input, id, reserved.shape);
  }

  /** register 的占用面应答：live 写者 → failure；同 id/同路径非 live 表项 → 幂等返回 */
  function registerOccupied(holder: string, id: string | undefined): void {
    const entry = deps.table.get(holder);
    if (entry === undefined || entry.state === "live" || entry.state === "spawning" || entry.state === "retiring") {
      respond(id, "thread/register", { error: "already open" });
      return;
    }
    respond(id, "thread/register", { data: { threadId: entry.threadId, cwd: entry.cwd, sessionPath: entry.sessionPath } });
  }

  async function handleThreadRegister(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    const fence = await fenceSessionPath(sessionPath, deps.sessionsRoot);
    if (!fence.ok) {
      respond(id, "thread/register", { error: fence.reason });
      return;
    }
    const holder = deps.table.holderOf(fence.sessionPath);
    if (holder !== undefined) {
      registerOccupied(holder, id);
      return;
    }
    const size = await stat(fence.sessionPath).then(
      (s) => s.size,
      () => -1,
    );
    if (size < 0 || size > DIRECT_READ_MAX_BYTES) {
      respond(id, "thread/register", { error: "Session file not readable" });
      return;
    }
    const state = await deps.direct.readState(fence.threadId);
    if (state === undefined) {
      respond(id, "thread/register", { error: "Session file not readable" });
      return;
    }
    // 占位复核：readState 的 await 窗口内 resume/start 可能已占同 path——insert 前
    // 重查，占位冲突走幂等分支
    const occupant = deps.table.holderOf(fence.sessionPath);
    if (occupant !== undefined) {
      registerOccupied(occupant, id);
      return;
    }
    const header = await deps.direct.readHeader(fence.threadId);
    if (deps.table.get(fence.threadId) === undefined) {
      deps.table.insert({
        threadId: fence.threadId,
        cwd: header?.cwd ?? process.cwd(),
        sessionPath: fence.sessionPath,
        state: "parked",
        trusted: input.trusted === true,
        keepalive: false,
      });
    }
    const entry = deps.table.get(fence.threadId);
    if (entry !== undefined) registerTrust(trust, input, entry.cwd);
    respond(id, "thread/register", { data: { threadId: fence.threadId, cwd: entry?.cwd ?? "", sessionPath: fence.sessionPath } });
  }

  function handleThreadStop(input: { [key: string]: unknown }, id: string | undefined): void {
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    deps.pool.retireThread(threadId, "stop"); // 幂等：未知 success
    respond(id, "thread/stop", {});
  }

  async function handleThreadDelete(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    const result = await deleteSession({ table: deps.table, sessionsRoot: deps.sessionsRoot, agentDir: deps.agentDir }, sessionPath);
    if (!result.ok) respond(id, "thread/delete", { error: result.reason });
    else respond(id, "thread/delete", {});
  }

  function handleThreadRetire(input: { [key: string]: unknown }, id: string | undefined): void {
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const outcome = deps.pool.retireThread(threadId, "retire");
    if (outcome === "not-persisted") {
      respond(id, "thread/retire", { error: "Session not persisted yet" });
    } else if (outcome === "in-flight") {
      // wake 重试在飞：命令排队由 wake 终态收口（耗尽落 dead 后本命令重发可重试）
      respond(id, "thread/retire", { error: "thread not live" });
    } else {
      respond(id, "thread/retire", {}); // 三态幂等 ack；thread_parked 帧在 close 结算发
    }
  }

  function handleThreadSetKeepalive(input: { [key: string]: unknown }, id: string | undefined): void {
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const keepalive = input.keepalive;
    if (typeof keepalive !== "boolean" || deps.table.get(threadId) === undefined) {
      respond(id, "thread/set_keepalive", { error: "Unknown threadId" });
      return;
    }
    deps.table.update(threadId, { keepalive });
    respond(id, "thread/set_keepalive", {});
  }

  function handleThreadList(_input: { [key: string]: unknown }, id: string | undefined): void {
    respond(id, "thread/list", {
      data: deps.table.list().map((entry) => ({
        threadId: entry.threadId,
        cwd: entry.cwd,
        sessionPath: entry.sessionPath,
        state: entry.state === "spawning" || entry.state === "retiring" ? "live" : entry.state,
        idleMs: entry.state === "live" ? entry.idleMs : 0,
        rssBytes: entry.state === "live" ? entry.rssBytes : null,
        keepalive: entry.keepalive,
        isStreaming: entry.state === "live" ? entry.isStreaming : false,
      })),
    });
  }

  async function handleThreadListSaved(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const rawCwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    const cwd = rawCwd !== undefined ? await normalizeCwd(rawCwd) : undefined; // 与存储侧 header.cwd 同口径（尾斜杠/symlink 拼法不漏会话）
    const sessions = await listSavedSessions(deps.sessionsRoot, cwd !== undefined ? { cwd } : {});
    respond(id, "thread/list_saved", { data: { sessions } });
  }

  async function handleAgentsList(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    // 目录栈（低→高）：user（恒在）；trusted 线程含 project 级（同名 project 覆盖
    //  user——来源按装载序分账：project 目录装载的条目标 project）
    const userDir = join(homedir(), ".x-harness", "agents");
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const entry = threadId !== "" ? deps.table.get(threadId) : undefined;
    const projectDir = entry !== undefined && entry.trusted ? join(entry.cwd, ".x-harness", "agents") : undefined;
    const builtinDir = builtinTypesDir(); // 随包内置类型（最低优先——assembly 单源）
    const dirs = [builtinDir, userDir, ...(projectDir !== undefined ? [projectDir] : [])];
    const projectLoaded = projectDir !== undefined ? loadAgentTypes([projectDir]) : undefined;
    const userLoaded = loadAgentTypes([builtinDir, userDir]);
    const merged = loadAgentTypes(dirs);
    const sourceOf = (name: string): "builtin" | "user" | "project" => {
      if (projectLoaded?.types[name] !== undefined) return "project";
      if (userLoaded.types[name] !== undefined) return "user";
      return "builtin";
    };
    const types = Object.values(merged.types).map((def) => ({
      name: def.name,
      description: def.description,
      source: sourceOf(def.name),
      ...(def.model !== undefined ? { model: def.model } : {}),
    }));
    respond(id, "agents/list", { data: { agents: types } });
  }

  function handleGetHostInfo(_input: { [key: string]: unknown }, id: string | undefined): void {
    respond(id, "get_host_info", {
      data: {
        version: deps.version,
        bunVersion: process.versions.bun ?? "",
        pid: process.pid,
        uptimeMs: Date.now() - deps.startedAt,
        rssBytes: process.memoryUsage().rss,
        threads: {
          live: deps.table.liveCount(),
          parked: deps.table.list().filter((e) => e.state === "parked").length,
          dead: deps.table.list().filter((e) => e.state === "dead").length,
        },
        limits: { ...deps.limits },
      },
    });
  }

  function handleSetIdleRetireMs(input: { [key: string]: unknown }, id: string | undefined): void {
    const value = input.value;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      respond(id, "set_idle_retire_ms", { error: `invalid: ${String(value)}` });
      return;
    }
    const clamped = clampIdleRetireMs(value);
    deps.setLimits({ idleRetireMs: clamped });
    respond(id, "set_idle_retire_ms", { data: { value: clamped } });
  }

  function handleSetRssRetireBytes(input: { [key: string]: unknown }, id: string | undefined): void {
    const value = input.value;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      respond(id, "set_rss_retire_bytes", { error: `invalid: ${String(value)}` });
      return;
    }
    const clamped = clampRssRetireBytes(value);
    deps.setLimits({ rssRetireBytes: clamped });
    respond(id, "set_rss_retire_bytes", { data: { value: clamped } });
  }

  function handleUiResponse(input: { [key: string]: unknown }, id: string | undefined): void {
    ctx.broadcastToWorkers(JSON.stringify(input));
    respond(id, "ui_response", {}); // 恒 ack（晚到/未知由 worker 忽略）
  }

  const handlers = new Map<string, LocalHandler>();
  handlers.set("thread/start", handleThreadStart);
  handlers.set("thread/resume", handleThreadResume);
  handlers.set("thread/register", handleThreadRegister);
  handlers.set("thread/stop", handleThreadStop);
  handlers.set("thread/delete", (input, id) => void handleThreadDelete(input, id));
  handlers.set("thread/retire", handleThreadRetire);
  handlers.set("thread/set_keepalive", handleThreadSetKeepalive);
  handlers.set("thread/list", handleThreadList);
  handlers.set("thread/list_saved", handleThreadListSaved);
  handlers.set("get_models", (_input, id) => modelsAuth.getModels(id));
  handlers.set("set_model_override", (input, id) => modelsAuth.setModelOverride(input as { provider?: unknown; modelId?: unknown; contextWindow?: unknown; maxTokens?: unknown; remove?: unknown }, id));
  handlers.set("auth/list", (_input, id) => modelsAuth.authList(id));
  handlers.set("auth/set_api_key", (input, id) => modelsAuth.authSetApiKey(input, id));
  handlers.set("auth/remove_key", (input, id) => modelsAuth.authRemoveKey(input, id));
  handlers.set("agents/list", handleAgentsList);
  handlers.set("get_host_info", handleGetHostInfo);
  handlers.set("set_idle_retire_ms", handleSetIdleRetireMs);
  handlers.set("set_rss_retire_bytes", handleSetRssRetireBytes);
  handlers.set("ui_response", handleUiResponse);
  const admin = createAdminCommands({ agentDir: deps.agentDir, sessionsRoot: deps.sessionsRoot, table: deps.table, trust, respond });
  admin.register(handlers);
  const permissionDual = admin.permissionDual;

  return {
    credentials,
    /** 返回 true = 已处理（host 本地，含 §3.4 parked/dead 直读接管）；false = 交池路由 */
    async handle(input: { type?: unknown; id?: unknown; [key: string]: unknown }): Promise<boolean> {
      const type = typeof input.type === "string" ? input.type : "";
      const id = typeof input.id === "string" ? input.id : undefined;
      const dual = await permissionDual(input, id);
      if (dual !== undefined) return dual;
      const handler = handlers.get(type);
      if (handler === undefined) {
        // §3.4 矩阵：线程域收敛/直读命令在表项 parked/dead 时 host 接管（免唤醒）；
        // live/spawning/retiring 或非接管集 → 交池（线程域由池路由，非线程域由池
        // 统一拒绝 unknown command）
        if (PARKED_DIRECT_COMMANDS.has(type)) {
          return await parkedReads.tryAnswer(type, input, id);
        }
        return false;
      }
      await handler(input, id);
      return true;
    },
  };
}

export type HostCommands = ReturnType<typeof createHostCommands>;
