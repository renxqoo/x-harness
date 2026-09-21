// 环境旋钮与常量单点（DESIGN §1/§9）：坏值降级缺省；阈值 clamp 防死亡循环；
// confirm 超时 / bash 溢写阈值等协议常量同住此处（禁双硬编码）。
export interface HubLimits {
  maxThreads: number;
  idleRetireMs: number;
  workerStaleMs: number;
  workerExitTimeoutMs: number;
  /** 0 = 关闭 RSS 硬顶 */
  rssRetireBytes: number;
  bashTimeoutMs: number;
}

export const CLIENT_LINE_LIMIT = 16 * 1024 * 1024; // client→host 与 host→worker 同限
export const WORKER_LINE_LIMIT = 128 * 1024 * 1024; // worker→host（get_messages 单帧数十 MB）
export const NON_LIVE_TABLE_CAP = 1024; // 非 live 表项 FIFO 上限
export const BASH_CONCURRENCY = 8; // 并发直执行槽位
export const CONFIRM_TIMEOUT_MS = 300_000; // confirm 弹窗统一超时（5min，超时默认拒绝）
export const BASH_OUTPUT_INLINE_CAP = 1024 * 1024; // 直执行输出内联上限（超则溢写文件）
export const STDOUT_RETRY_MAX = 100; // ENOBUFS/EAGAIN 重试上限（超则降级 stderr 丢帧）
export const STDOUT_RETRY_DELAY_MS = 10;
export const FORK_GRACE_SIGTERM_MS = 2_000; // 杀 worker：SIGTERM 宽限后 SIGKILL
export const DIRECT_READ_MAX_BYTES = 64 * 1024 * 1024; // register 直读上限
export const WORKER_SPAWN_TIMEOUT_MS = 10_000; // hello 截止
export const PENDING_COMMANDS_CAP = 65_536; // 命令风暴上限（host 侧 pending 表）
export const BASH_OUTPUT_INLINE_RESPONSE_CAP = 64 * 1024; // bash 响应 output 内联截断
export const BASH_OUTPUT_MEMORY_CAP = 8 * 1024 * 1024; // bash 输出内存累积封顶（truncated 粘滞）
export const INFLIGHT_TOOL_TAIL_BYTES = 64 * 1024; // get_inflight toolOutputs 尾部
export const INFLIGHT_TOOL_MAX = 8; // get_inflight toolOutputs 条数
export const TOOL_STREAM_MIN_INTERVAL_MS = 25; // agent/tool-stream 帧尾沿合并间隔（火喉输出下 wire 帧率有界）
export const PROMPT_IMAGE_DATA_MAX = 5 * 1024 * 1024; // 单图 base64 串长上限
export const PROMPT_IMAGES_MAX = 8; // 单 prompt 图像张数上限
export const PROMPT_IMAGES_TOTAL_MAX = 12 * 1024 * 1024; // 单 prompt 图像总字节上限（16MiB 行限内的诚实余量）
export const WORKER_RESPONSE_SOFT_CAP = 100 * 1024 * 1024; // worker 单响应软上限（超限 failure 引导 get_entries——防 128MiB 行限击穿杀 worker）

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

/** rss 域特殊：0=关；开则夹 [256MiB, 2TiB]（下限防「低于 bun 基线→resume 秒回收」死循环） */
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

/** 运行时旋钮改写共用同一 clamp 面（回显生效值 = clamp 后值） */
export function clampIdleRetireMs(value: number): number {
  return clamp(value, IDLE_FLOOR, IDLE_CEIL);
}

export function clampRssRetireBytes(value: number): number {
  return clampRss(value);
}

function clampNonNegative(value: number, ceil: number): number {
  return Math.min(ceil, Math.max(0, value));
}
