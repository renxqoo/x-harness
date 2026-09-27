// L2 帧 kind 词表与 body 形状（DESIGN §1.2）。词表封闭：未知 kind 接收方忽略+计数
// （minor 兼容规则 §1.6）；本文件是 kind 判别联合的单一真相。
export const FRAME_KINDS = [
  "command",
  "response",
  "event",
  "ui_request",
  "ui_response",
  "ack",
  "chunk",
  "pairing",
  "hello",
  "rekey",
  "bye",
  "error",
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** host 命令帧（客户端→gateway） */
export interface CommandBody {
  command: string;
  id: string;
  args?: Record<string, unknown>;
}

/** host response 帧（gateway→客户端；id 为客户端原 id） */
export interface ResponseBody {
  id: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** 事件帧（gateway→客户端；host 事件词表透传 + gateway 合成域） */
export interface EventBody {
  threadId: string;
  name: string;
  payload: unknown;
  agentName?: string;
  /** gateway 合成域帧的代际（fork/clone/delete 后 +1，§1.2.2） */
  epoch?: number;
}

export interface UiRequestBody {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}

export interface UiResponseBody {
  requestId: string;
  payload: Record<string, unknown>;
}

/** ACK 合并帧：最高连续 seq（§1.2） */
export interface AckBody {
  acks: Array<{ streamId: string; upTo: number }>;
}

/** 分片帧：streamId/seq 同属首片所属逻辑帧 */
export interface ChunkBody {
  segmentId: number;
  segmentCount: number;
  totalBytes: number;
  /** base64(明文帧 JSON 切片) */
  data: string;
}

/** 配对面帧（pairing 流；kind=pairing，body 判别联合） */
export type PairingBody =
  | { p: "request"; ephemeralPub: string; deviceInfo: DeviceInfoBody; pakeA?: string }
  | { p: "pake-b"; pakeB: string }
  | { p: "gateway-info"; relayKeyFingerprint: string; gatewayKeyFingerprint: string; sig: string }
  | { p: "device-keys"; longTermPub: string; encPub: string; sig: string }
  | { p: "sas"; sas: string }
  | { p: "confirm"; ownerSas: string }
  | { p: "registered"; deviceId: string; scope: ScopeWord; relayToken: string }
  | { p: "rejected"; reason: string };

export interface DeviceInfoBody {
  name: string;
  deviceType: string;
  platform: string;
  appVersion: string;
}

/** hello（双向）：协议版本、caps、游标、订阅（§1.2/§1.2.3） */
export interface HelloBody {
  protoMajor: number;
  protoMinor: number;
  caps: readonly string[];
  /** 客户端→gateway：重连游标与订阅 */
  cursors?: ReadonlyArray<{ streamId: string; since: number; logEpoch?: number }>;
  subs?: ReadonlyArray<{ threadId: string; since: number; logEpoch?: number }>;
  /** gateway→客户端：活跃流基线宣告（订阅基线，§1.2） */
  bases?: ReadonlyArray<{ streamId: string; baseSeq: number }>;
  /** ratchet 链指纹（§1.3 失步检测） */
  chainFingerprint?: string;
}

export interface ByeBody {
  reason: string;
}

export interface ErrorBody {
  code:
    | "no-route"
    | "gap"
    | "cursor-too-old"
    | "command-expired"
    | "ratchet-regression"
    | "version-mismatch"
    | "rate-limited"
    | "scope-denied"
    | "owner-only"
    | "unknown-command"
    | "bad-frame"
    | "auth-failed"
    | "shutting-down"
    | "host-unavailable";
  message?: string;
}

/** scope 词表（封闭，§3.1） */
export const SCOPE_WORDS = ["read", "interact", "full"] as const;
export type ScopeWord = (typeof SCOPE_WORDS)[number];

/** L2 信封（E2E 密文内的明文结构） */
export interface Frame {
  kind: FrameKind;
  streamId: string;
  seq: number;
  body: unknown;
}
