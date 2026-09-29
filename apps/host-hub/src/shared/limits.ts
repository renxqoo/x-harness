export interface HubLimits {
  maxThreads: number;
  idleRetireMs: number;
  workerStaleMs: number;
  workerExitTimeoutMs: number;
  rssRetireBytes: number;
  bashTimeoutMs: number;
}

export const CLIENT_LINE_LIMIT = 16 * 1024 * 1024;
export const WORKER_LINE_LIMIT = 128 * 1024 * 1024;
export const NON_LIVE_TABLE_CAP = 1024;
export const BASH_CONCURRENCY = 8;
export const CONFIRM_TIMEOUT_MS = 300_000;
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

function clampRss(value: number): number {
  if (value === 0) return 0;
  return clamp(value, RSS_FLOOR, RSS_CEIL);
}

export function readLimits(env: Record<string, string | undefined> = process.env): HubLimits {
  return {
    maxThreads: Math.max(1, intEnv(env["HUB_MAX_THREADS"], 32)),
    idleRetireMs: clamp(intEnv(env["HUB_IDLE_RETIRE_MS"], 900_000), IDLE_FLOOR, IDLE_CEIL),
    workerStaleMs: clamp(intEnv(env["HUB_WORKER_STALE_MS"], 30_000), 1_000, IDLE_CEIL),
    workerExitTimeoutMs: clamp(intEnv(env["HUB_WORKER_EXIT_TIMEOUT_MS"], 10_000), 1_000, IDLE_CEIL),
    rssRetireBytes: clampRss(intEnv(env["HUB_RSS_RETIRE_BYTES"], 0)),
    bashTimeoutMs: clampNonNegative(intEnv(env["HUB_BASH_TIMEOUT_MS"], 600_000), 86_400_000),
  };
}

export function clampIdleRetireMs(value: number): number {
  return clamp(value, IDLE_FLOOR, IDLE_CEIL);
}

export function clampRssRetireBytes(value: number): number {
  return clampRss(value);
}

function clampNonNegative(value: number, ceil: number): number {
  return Math.min(ceil, Math.max(0, value));
}
