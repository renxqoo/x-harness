// host 本地命令（DESIGN §3）：线程生命周期准入（围栏/占用/预算）、模型目录与
// overrides、凭据、宿主信息与旋钮、agents/list、ui_response 广播。非本集且非线程域
// → unknown command（池侧统一拒）；缺 threadId 由池侧判（线程域命令）。
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentTypes } from "@x-harness/agent-delegation";
import { responseFrame, hubErrorFrame } from "../protocol/frames.ts";
import { clampIdleRetireMs, clampRssRetireBytes, DIRECT_READ_MAX_BYTES } from "../shared/limits.ts";
import { readCatalog } from "../shared/catalog.ts";
import type { WorkerPool } from "./worker-pool.ts";
import type { ThreadTable } from "./thread-table.ts";
import { fenceSessionPath } from "./read-history.ts";
import type { DirectRead } from "./read-history.ts";
import { listSavedSessions } from "./saved-query.ts";
import { PARKED_DIRECT_COMMANDS, createParkedReads } from "./parked-reads.ts";
import { createCredentials, redact } from "./credentials.ts";
import type { CredentialStore } from "./credentials.ts";
import { createAdminCommands } from "./admin-commands.ts";
import { createTrustStore } from "./trust-store.ts";
import type { TrustStore } from "./trust-store.ts";
import { updateProvidersFile } from "./models-admin.ts";

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

/** auth/list 三态：有存 key/档案字面 → api-key；仅 env 键名 → preset-env；皆无 → none */
function authTypeOf(hasLiteral: boolean, hasEnvName: boolean): "api-key" | "preset-env" | "none" {
  if (hasLiteral) return "api-key";
  if (hasEnvName) return "preset-env";
  return "none";
}

/** host 本地命令处理器面（注册表按命令名一分派） */
type LocalHandler = (input: { type?: unknown; id?: unknown; [key: string]: unknown }, id: string | undefined) => Promise<void> | void;

/** 非法数值回显的数组元素面：null/undefined 空串、嵌套数组递归（String 语义） */
function arrayElementText(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  if (typeof value === "undefined") return "";
  return String(value);
}

/** 非法数值回显：保持 String 语义（数组 join/对象 [object Object]——错误文案不变） */
function invalidValueText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(arrayElementText).join(",");
  if (typeof value === "object") return "[object Object]";
  return String(value);
}

/** set_model_override 校验段：字段组合与数值合法性（错误文案单点） */
function validateOverrideInput(
  input: { contextWindow?: unknown; maxTokens?: unknown; remove?: unknown },
): { ok: true; remove: boolean; contextWindow: unknown; maxTokens: unknown } | { ok: false; error: string } {
  const remove = input.remove === true;
  const cw = input.contextWindow;
  const mt = input.maxTokens;
  if (!remove && cw === undefined && mt === undefined) {
    return { ok: false, error: "invalid: nothing to set (provide contextWindow/maxTokens or remove)" };
  }
  for (const value of [cw, mt]) {
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      return { ok: false, error: `invalid: ${invalidValueText(value)} must be a positive integer or null` };
    }
  }
  if (remove && (cw !== undefined || mt !== undefined)) {
    return { ok: false, error: "invalid: remove is exclusive with field updates" };
  }
  return { ok: true, remove, contextWindow: cw, maxTokens: mt };
}

/** 词法围栏（同步段）：绝对路径 + 布局 + id 词法——不含 fs（realpath 复核在占位后） */
function shapeFence(sessionPath: string): { ok: true; threadId: string; sessionPath: string } | { ok: false; reason: string } {
  if (!sessionPath.startsWith("/")) {
    return { ok: false, reason: "session path outside sessions dir: absolute path required" };
  }
  const parts = sessionPath.split("/");
  const file = parts.at(-1);
  const id = parts.at(-2) ?? "";
  if (file !== "events.jsonl" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    return { ok: false, reason: "session path outside sessions dir: malformed layout" };
  }
  return { ok: true, threadId: id, sessionPath };
}

type OverrideFile = { modelOverrides?: Record<string, { contextWindow?: number; maxOutputTokens?: number }> };

/** overrides 键变更：remove 删键；字段更新后空键自删 */
function applyOverrideEntry(file: OverrideFile, key: string, fields: { remove: boolean; contextWindow: unknown; maxTokens: unknown }): void {
  file.modelOverrides ??= {};
  if (fields.remove) {
    delete file.modelOverrides[key];
    return;
  }
  const entry = file.modelOverrides[key] ?? {};
  if (fields.contextWindow === null) delete entry.contextWindow;
  else if (typeof fields.contextWindow === "number") entry.contextWindow = fields.contextWindow;
  if (fields.maxTokens === null) delete entry.maxOutputTokens;
  else if (typeof fields.maxTokens === "number") entry.maxOutputTokens = fields.maxTokens;
  if (entry.contextWindow === undefined && entry.maxOutputTokens === undefined) delete file.modelOverrides[key];
  else file.modelOverrides[key] = entry;
}

/** 刷新后模型对象（附录 B 形状——单点构造） */
function modelShapeOf(entry: { model: string; provider: string; contextWindow?: number; maxTokens?: number; cost?: Record<string, number>; source: "preset" | "custom" } | undefined): Record<string, unknown> | undefined {
  if (entry === undefined) return undefined;
  return {
    id: entry.model,
    provider: entry.provider,
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.cost !== undefined ? { cost: entry.cost } : {}),
    source: entry.source,
  };
}

/** trusted:true 的注册表登记（start/resume/register 共用——host 转发链执行，
 *  worker 永不写注册表） */
function registerTrust(trust: TrustStore, input: { trusted?: unknown }, cwd: string): void {
  if (input.trusted === true) void trust.trust(cwd);
}

export function createHostCommands(deps: HostCommandsDeps, ctx: HostCommandContext) {
  const credentials: CredentialStore = createCredentials(deps.agentDir);
  const trust = createTrustStore(deps.agentDir);
  const parkedReads = createParkedReads({ table: deps.table, direct: deps.direct, emitClient: deps.emitClient });

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

  async function setModelOverride(
    input: { provider?: unknown; modelId?: unknown; contextWindow?: unknown; maxTokens?: unknown; remove?: unknown },
    id: string | undefined,
  ): Promise<void> {
    const provider = typeof input.provider === "string" ? input.provider : "";
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    const catalog = await readCatalog(deps.agentDir);
    const known = catalog.entries.some((e) => e.provider === provider && e.model === modelId);
    if (!known) {
      respond(id, "set_model_override", {
        error: `unknown model preset: ${modelId} (available: ${catalog.entries.map((e) => e.model).join(", ")})`,
      });
      return;
    }
    const verdict = validateOverrideInput(input);
    if (!verdict.ok) {
      respond(id, "set_model_override", { error: verdict.error });
      return;
    }
    const key = `${provider}::${modelId}`;
    await updateProvidersFile(deps.agentDir, (file) => {
      applyOverrideEntry(file, key, verdict);
      return file;
    });
    // 热刷新 = 每次读取现算（readCatalog 无缓存）——响应回显刷新后模型对象
    const refreshed = await readCatalog(deps.agentDir);
    const entry = refreshed.entries.find((e) => e.provider === provider && e.model === modelId);
    respond(id, "set_model_override", { data: { model: modelShapeOf(entry) } });
  }

  /** thread/resume 占位段：词法围栏 + 有界等待释放 + 预算 + 表占位（先于复核段） */
  async function reserveResumeSlot(
    input: { [key: string]: unknown },
    id: string | undefined,
  ): Promise<{ ok: true; shape: { threadId: string; sessionPath: string } } | { ok: false }> {
    const sessionPath = typeof input.sessionPath === "string" ? input.sessionPath : "";
    // 同步段：词法围栏 + 占用声明——先于一切 await（消灭双开竞态窗口）；
    // realpath 围栏在占位后复核（失败撤位应答）
    const shape = shapeFence(sessionPath);
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
    const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
    const sessions = await listSavedSessions(deps.sessionsRoot, cwd !== undefined ? { cwd } : {});
    respond(id, "thread/list_saved", { data: { sessions } });
  }

  async function handleGetModels(_input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const catalog = await readCatalog(deps.agentDir);
    if (catalog.degraded) {
      deps.emitClient(hubErrorFrame("providers.json unreadable; preset-only catalog"));
    }
    respond(id, "get_models", {
      data: catalog.entries.map((e) => ({
        id: e.model,
        provider: e.provider,
        ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
        ...(e.maxTokens !== undefined ? { maxTokens: e.maxTokens } : {}),
        ...(e.cost !== undefined ? { cost: e.cost } : {}),
        source: e.source,
      })),
    });
  }

  async function handleAuthList(_input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const catalog = await readCatalog(deps.agentDir);
    const creds = await credentials.read();
    const providers = catalog.profiles.map((profile) => ({
      provider: profile.name,
      type: authTypeOf(creds.keys[profile.name] !== undefined || profile.apiKey !== undefined, profile.apiKeyEnv !== undefined),
    }));
    respond(id, "auth/list", { data: { providers } });
  }

  async function handleAuthSetApiKey(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const provider = typeof input.provider === "string" ? input.provider : "";
    const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
    const catalog = await readCatalog(deps.agentDir);
    if (!catalog.profiles.some((profile) => profile.name === provider)) {
      respond(id, "auth/set_api_key", { error: redact(`auth provider not in catalog: ${provider}`, [apiKey]) });
      return;
    }
    if (apiKey === "") {
      respond(id, "auth/set_api_key", { error: "invalid: apiKey required" });
      return;
    }
    try {
      await credentials.setKey(provider, apiKey);
      await ctx.refreshSnapshot(); // 新 key 立即可注入后续 spawn
      respond(id, "auth/set_api_key", {});
    } catch (error) {
      respond(id, "auth/set_api_key", { error: redact(String(error), [apiKey]) });
    }
  }

  async function handleAuthRemoveKey(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    const provider = typeof input.provider === "string" ? input.provider : "";
    await credentials.removeKey(provider);
    await ctx.refreshSnapshot(); // 撤 key 后续 spawn 不再注入
    respond(id, "auth/remove_key", {});
  }

  async function handleAgentsList(input: { [key: string]: unknown }, id: string | undefined): Promise<void> {
    // 目录栈（低→高）：user（恒在）；trusted 线程含 project 级（同名 project 覆盖
    //  user——来源按装载序分账：project 目录装载的条目标 project）
    const userDir = join(homedir(), ".x-harness", "agents");
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    const entry = threadId !== "" ? deps.table.get(threadId) : undefined;
    const projectDir = entry !== undefined && entry.trusted ? join(entry.cwd, ".x-harness", "agents") : undefined;
    const userLoaded = loadAgentTypes([userDir]);
    const merged = projectDir !== undefined ? loadAgentTypes([userDir, projectDir]) : userLoaded;
    const types = Object.values(merged.types).map((def) => ({
      name: def.name,
      description: def.description,
      source: projectDir !== undefined && userLoaded.types[def.name] === undefined ? "project" : "user",
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
  handlers.set("thread/retire", handleThreadRetire);
  handlers.set("thread/set_keepalive", handleThreadSetKeepalive);
  handlers.set("thread/list", handleThreadList);
  handlers.set("thread/list_saved", handleThreadListSaved);
  handlers.set("get_models", handleGetModels);
  handlers.set("set_model_override", (input, id) => setModelOverride(input as { provider?: unknown; modelId?: unknown; contextWindow?: unknown; maxTokens?: unknown; remove?: unknown }, id));
  handlers.set("auth/list", handleAuthList);
  handlers.set("auth/set_api_key", handleAuthSetApiKey);
  handlers.set("auth/remove_key", handleAuthRemoveKey);
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
