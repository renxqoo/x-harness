// relay 常量单点（DESIGN §1.5/§4/§8）
/** 单节点连接上限 */
export const MAX_CONNECTIONS = 10_000;
/** WSS ping/pong（对齐协议包常量；此处为 relay 侧执法值） */
export const PING_INTERVAL_MS = 10_000;
export const PONG_TIMEOUT_MS = 60_000;
/** token TTL（秒）——HS256 exp */
export const TOKEN_TTL_SECONDS = 15 * 60;
/** 撤销名单传播：共享存储 PUBLISH 频道 */
export const REVOKE_CHANNEL = "xh-relay:revoke";
/** 路由表键前缀（共享存储命名空间） */
export const ROUTE_KEY_INSTALLATION = "xh-relay:route:installation:";
export const ROUTE_KEY_DEVICE = "xh-relay:route:device:";
export const REVOKE_SET_KEY = "xh-relay:revoked";
/** 跨节点转发频道（pattern 形态——订阅侧按频道名解析目标 installation） */
export const ROUTE_PATTERN_CHANNEL = "xh-relay:route:";
/** L3 信封字节门（对齐 DESIGN §3.5 16MiB 线上帧上限） */
export const ENVELOPE_MAX_BYTES = 16 * 1024 * 1024;
/** 转发频控：每连接帧速率（帧/s，超限断连——DoS 防线） */
export const FRAME_RATE_PER_SEC = 200;
export const FRAME_RATE_BURST = 400;
/** pairingTicket TTL（秒） */
export const PAIRING_TICKET_TTL_SECONDS = 150;
