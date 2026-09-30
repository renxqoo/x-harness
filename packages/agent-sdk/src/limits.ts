export interface SdkLimits {
  maxThreads: number;
  idleRetireMs: number;
  rssRetireBytes: number;
  bashTimeoutMs: number;
  confirmTimeoutMs: number;
  workerStaleMs: number;
  workerExitTimeoutMs: number;
  pendingCommandsCap: number;
  eventQueueCapacity: number;
  requeueMaxPerThread: number;
  requeueMaxBytesPerThread: number;
  shutdownBudgetMs: number;
}

export const CLIENT_LINE_LIMIT = 16 * 1024 * 1024;
export const WORKER_LINE_LIMIT = 128 * 1024 * 1024;
export const NON_LIVE_TABLE_CAP = 1024;
export const BASH_CONCURRENCY = 8;
export const BASH_OUTPUT_INLINE_CAP = 1024 * 1024;
export const STDOUT_RETRY_MAX = 100;
export const STDOUT_RETRY_DELAY_MS = 10;
export const FORK_GRACE_SIGTERM_MS = 2_000;
export const DIRECT_READ_MAX_BYTES = 64 * 1024 * 1024;
export const WORKER_SPAWN_TIMEOUT_MS = 10_000;
export const PENDING_COMMANDS_CAP = 65_536;
export const BASH_OUTPUT_INLINE_RESPONSE_CAP = 64 * 1024;
export const BASH_OUTPUT_MEMORY_CAP = 8 * 1024 * 1024;
export const INFLIGHT_TOOL_TAIL_BYTES = 64 * 1024;
export const INFLIGHT_TOOL_MAX = 8;
export const TOOL_STREAM_MIN_INTERVAL_MS = 25;
export const PROMPT_IMAGE_DATA_MAX = 5 * 1024 * 1024;
export const PROMPT_IMAGES_MAX = 8;
export const PROMPT_IMAGES_TOTAL_MAX = 12 * 1024 * 1024;
export const SKILL_INSPECT_MAX_PATHS = 200;
export const PLUGIN_INSPECT_MAX_PATHS = 200;
export const PLUGIN_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const PLUGIN_IMPORT_MAX_ENTRIES = 4096;
export const SKILL_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const SKILL_IMPORT_MAX_ENTRIES = 4096;
export const WORKER_RESPONSE_SOFT_CAP = 100 * 1024 * 1024;
export const MAX_REQUEUE_PER_THREAD = 1_024;
export const MAX_REQUEUE_BYTES_PER_THREAD = 4 * 1024 * 1024;
export const RESUME_RETRIES = 12;
export const RESUME_RETRY_INTERVAL_MS = 1_000;
export const SHUTDOWN_TOTAL_BUDGET_MS = 30_000;
export const WORLD_TEARDOWN_TIMEOUT_MS = 10_000;
export const EVENT_QUEUE_CAPACITY_DEFAULT = 1024;

const RSS_FLOOR = 256 * 1024 * 1024;
const RSS_CEIL = 2 * 1024 * 1024 * 1024 * 1024;
const IDLE_FLOOR = 1_000;
const IDLE_CEIL = 24 * 60 * 60 * 1000;

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

function clamp(value: number, floor: number, ceil: number): number {
  return Math.min(ceil, Math.max(floor, value));
}

function clampIdle(value: number): number {
  if (value === 0) return 0;
  return clamp(value, IDLE_FLOOR, IDLE_CEIL);
}

function clampConfirm(value: number): number {
  if (value === 0) return 0;
  return clamp(value, IDLE_FLOOR, IDLE_CEIL);
}

function clampRss(value: number): number {
  if (value === 0) return 0;
  return clamp(value, RSS_FLOOR, RSS_CEIL);
}

function clampNonNegative(value: number, ceil: number): number {
  return Math.min(ceil, Math.max(0, value));
}

export function clampIdleRetireMs(value: number): number {
  return clampIdle(value);
}

export function clampConfirmTimeoutMs(value: number): number {
  return clampConfirm(value);
}

export function clampRssRetireBytes(value: number): number {
  return clampRss(value);
}

export function readLimits(env: Record<string, string | undefined>): SdkLimits {
  return {
    maxThreads: Math.max(1, intEnv(env["HUB_MAX_THREADS"], 32)),
    idleRetireMs: clampIdle(intEnv(env["HUB_IDLE_RETIRE_MS"], 900_000)),
    rssRetireBytes: clampRss(intEnv(env["HUB_RSS_RETIRE_BYTES"], 0)),
    bashTimeoutMs: clampNonNegative(intEnv(env["HUB_BASH_TIMEOUT_MS"], 600_000), 86_400_000),
    confirmTimeoutMs: clampConfirm(intEnv(env["HUB_CONFIRM_TIMEOUT_MS"], 300_000)),
    workerStaleMs: clamp(intEnv(env["HUB_WORKER_STALE_MS"], 30_000), 1_000, IDLE_CEIL),
    workerExitTimeoutMs: clamp(intEnv(env["HUB_WORKER_EXIT_TIMEOUT_MS"], 10_000), 1_000, IDLE_CEIL),
    pendingCommandsCap: Math.max(1, intEnv(env["HUB_PENDING_COMMANDS_CAP"], PENDING_COMMANDS_CAP)),
    eventQueueCapacity: Math.max(16, intEnv(env["HUB_EVENT_QUEUE_CAPACITY"], EVENT_QUEUE_CAPACITY_DEFAULT)),
    requeueMaxPerThread: Math.max(1, intEnv(env["HUB_REQUEUE_MAX_PER_THREAD"], MAX_REQUEUE_PER_THREAD)),
    requeueMaxBytesPerThread: Math.max(1024, intEnv(env["HUB_REQUEUE_MAX_BYTES_PER_THREAD"], MAX_REQUEUE_BYTES_PER_THREAD)),
    shutdownBudgetMs: clamp(intEnv(env["HUB_SHUTDOWN_BUDGET_MS"], SHUTDOWN_TOTAL_BUDGET_MS), 1_000, 120_000),
  };
}
