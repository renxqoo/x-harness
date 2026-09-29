export const PROTO_MAJOR = 1;
export const PROTO_MINOR = 0;

export const CAP_WORDS = ["chunk", "coalesce", "snapshot-hydrate"] as const;
export type CapWord = (typeof CAP_WORDS)[number];

export const WIRE_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const PLAIN_FRAME_CHUNK_THRESHOLD = 4 * 1024 * 1024;
export const REASSEMBLY_MAX_BYTES = 128 * 1024 * 1024;
export const REASSEMBLY_MAX_SEGMENTS = 1024;
export const DEVICE_REASSEMBLY_MAX_BYTES = 256 * 1024 * 1024;

export const REORDER_BUFFER_MAX = 1024;
export const REPLAY_BUFFER_MAX = 1024;
export const DEVICE_MAX_STREAMS = 64;

export const DEVICE_BYTES_PER_SEC = 2 * 1024 * 1024;
export const DEVICE_BYTES_BURST = 8 * 1024 * 1024;
export const DEVICE_CMDS_PER_SEC = 10;
export const DEVICE_CMDS_BURST = 20;

export const ACK_EVERY_FRAMES = 32;
export const ACK_INTERVAL_MS = 250;

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_LOCKOUT_MS = 5 * 60_000;
export const PAIRING_MAX_CONCURRENT = 8;
export const SAS_DIGITS = 6;
export const MANUAL_CODE_DIGITS = 8;

export const RATCHET_BATCH_FRAMES = 64;
export const RATCHET_BATCH_MS = 200;
export const RATCHET_SKIPPED_KEY_MAX = 1024;
export const RATCHET_FORCE_REKEY_MESSAGES = 2000;
export const RATCHET_FORCE_REKEY_MS = 24 * 60 * 60 * 1000;
export const TAG_FAILURE_REKEY_THRESHOLD = 32;

export const RELAY_TOKEN_TTL_MS = 15 * 60_000;

export const WSS_PING_INTERVAL_MS = 10_000;
export const WSS_PONG_TIMEOUT_MS = 60_000;

export const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;

export const COMMAND_LOG_RING_MAX = 16_384;
export const STARTUP_DEFER_QUEUE_MAX = 1024;
export const STARTUP_DEFER_DEADLINE_MS = 30_000;
