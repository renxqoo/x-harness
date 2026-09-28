// 协议常量单点（DESIGN §3.5 尺寸预算 / §8 资源预算）：坏值不在此容错——调用方按
// 缺省构造；本文件只定义事实，不读环境。
export const PROTO_MAJOR = 1;
export const PROTO_MINOR = 0;

/** caps 词表（封闭，DESIGN §1.6） */
export const CAP_WORDS = ["chunk", "coalesce", "snapshot-hydrate"] as const;
export type CapWord = (typeof CAP_WORDS)[number];

/** L3 线上帧字节上限（对齐 host CLIENT_LINE_LIMIT 量级） */
export const WIRE_FRAME_MAX_BYTES = 16 * 1024 * 1024;
/** 明文 L2 帧上限：超出切 chunk（DESIGN §1.2） */
export const PLAIN_FRAME_CHUNK_THRESHOLD = 4 * 1024 * 1024;
/** 重组上限：128MiB / 1024 片（覆盖 host get_messages 100MiB 软上限满配） */
export const REASSEMBLY_MAX_BYTES = 128 * 1024 * 1024;
export const REASSEMBLY_MAX_SEGMENTS = 1024;
/** per-device 重组聚合上限（§8） */
export const DEVICE_REASSEMBLY_MAX_BYTES = 256 * 1024 * 1024;

/** per-stream 重排缓冲与历史重放缓冲（帧数） */
export const REORDER_BUFFER_MAX = 1024;
export const REPLAY_BUFFER_MAX = 1024;
/** per-device 并发流上限（§8） */
export const DEVICE_MAX_STREAMS = 64;

/** 限流（§8）：字节级预解密 + 命令桶 */
export const DEVICE_BYTES_PER_SEC = 2 * 1024 * 1024;
export const DEVICE_BYTES_BURST = 8 * 1024 * 1024;
export const DEVICE_CMDS_PER_SEC = 10;
export const DEVICE_CMDS_BURST = 20;

/** ACK 合并（§1.2）：每 32 帧或 250ms */
export const ACK_EVERY_FRAMES = 32;
export const ACK_INTERVAL_MS = 250;

/** 配对（§1.4） */
export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_LOCKOUT_MS = 5 * 60_000;
export const PAIRING_MAX_CONCURRENT = 8;
/** SAS 显示位数 */
export const SAS_DIGITS = 6;
/** 手输码位数 */
export const MANUAL_CODE_DIGITS = 8;

/** ratchet（§1.3） */
export const RATCHET_BATCH_FRAMES = 64;
export const RATCHET_BATCH_MS = 200;
export const RATCHET_SKIPPED_KEY_MAX = 1024;
export const RATCHET_FORCE_REKEY_MESSAGES = 2000;
export const RATCHET_FORCE_REKEY_MS = 24 * 60 * 60 * 1000;
/** tag 连续失败阈值（超限触发 re-key 探测） */
export const TAG_FAILURE_REKEY_THRESHOLD = 32;

/** relay token（§1.5） */
export const RELAY_TOKEN_TTL_MS = 15 * 60_000;

/** relay WSS 心跳（§4）：ping 10s / pong 60s */
export const WSS_PING_INTERVAL_MS = 10_000;
export const WSS_PONG_TIMEOUT_MS = 60_000;

/** 客户端重连退避（§4）：1s→30s 封顶 + jitter */
export const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** 去重日志环形上限（条/设备，§1.2.1） */
export const COMMAND_LOG_RING_MAX = 16_384;
/** 启动窗口命令推迟队列（§4） */
export const STARTUP_DEFER_QUEUE_MAX = 1024;
export const STARTUP_DEFER_DEADLINE_MS = 30_000;
