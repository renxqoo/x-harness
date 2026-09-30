import type { SessionEvent } from "@x-harness/session";
import type { AssistantStreamFrame } from "@x-harness/agent-loop";
import type { SdkErrorCode } from "./errors.ts";

export type { AssistantStreamFrame };

export interface WireImage {
  base64: string;
  mediaType: string;
}

export type ThreadStateName = "spawning" | "live" | "retiring" | "parked" | "dead";

export type SdkEvent =
  | { kind: "stream"; threadId: string; owner: string; turn: number; step: number; agentName?: string; frame: AssistantStreamFrame }
  | { kind: "tool_stream"; threadId: string; owner: string; callId: string; agentName?: string; delta: string }
  | { kind: "tool_result"; threadId: string; callId: string; summary: string; ok: boolean }
  | { kind: "settled"; threadId: string; sendId: string; ok: boolean; reason?: string }
  | { kind: "platform"; threadId: string; name: string; payload: unknown; agentName?: string }
  | { kind: "session"; threadId: string; owner: string; event: SessionEvent }
  | { kind: "ui_request"; threadId: string; requestId: string; method: string; payload: Record<string, unknown>; respond: (data: unknown) => void }
  | { kind: "thread_state"; threadId: string; from: ThreadStateName; to: ThreadStateName; cause: string }
  | { kind: "thread_rekeyed"; threadId: string; oldThreadId: string }
  | { kind: "heartbeat"; threadId: string; idleMs: number; streaming: boolean; rssBytes: number | null }
  | { kind: "git_changed"; threadId: string; cwd: string; branch?: string }
  | { kind: "error"; threadId?: string; code: SdkErrorCode; message: string };

export type SdkEventKind = SdkEvent["kind"];

export const SDK_EVENT_KINDS: readonly SdkEventKind[] = [
  "stream",
  "tool_stream",
  "tool_result",
  "settled",
  "platform",
  "session",
  "ui_request",
  "thread_state",
  "thread_rekeyed",
  "heartbeat",
  "git_changed",
  "error",
];
