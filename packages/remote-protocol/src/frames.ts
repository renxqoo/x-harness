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

export interface CommandBody {
  command: string;
  id: string;
  args?: Record<string, unknown>;
}

export interface ResponseBody {
  id: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface EventBody {
  threadId: string;
  name: string;
  payload: unknown;
  agentName?: string;
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

export interface AckBody {
  acks: Array<{ streamId: string; upTo: number }>;
}

export interface ChunkBody {
  segmentId: number;
  segmentCount: number;
  totalBytes: number;
  data: string;
}

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

export interface HelloBody {
  protoMajor: number;
  protoMinor: number;
  caps: readonly string[];
  cursors?: ReadonlyArray<{ streamId: string; since: number; logEpoch?: number }>;
  subs?: ReadonlyArray<{ threadId: string; since: number; logEpoch?: number }>;
  bases?: ReadonlyArray<{ streamId: string; baseSeq: number }>;
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

export const SCOPE_WORDS = ["read", "interact", "full"] as const;
export type ScopeWord = (typeof SCOPE_WORDS)[number];

export interface Frame {
  kind: FrameKind;
  streamId: string;
  seq: number;
  body: unknown;
}
