import type { AgentMessageKind, ContentBlock, SessionEvent, SessionEventData } from "./types.ts";

export const AGENT_MESSAGE_KINDS: ReadonlySet<string> = new Set(["directive", "content"]);

export interface AgentMessageInput {
  readonly turn: number;
  readonly step: number;
  readonly source: string;
  readonly kind: AgentMessageKind;
  readonly content: readonly ContentBlock[];
}

export function agentMessageData(input: AgentMessageInput): SessionEventData["agent/message"] {
  return { turn: input.turn, step: input.step, source: input.source, kind: input.kind, content: [...input.content] };
}

export type AgentMessageEvent = SessionEvent<"agent/message">;

export function isAgentDirective(event: SessionEvent): boolean {
  return event.type === "agent/message" && event.data.kind === "directive";
}

export function isAgentContent(event: SessionEvent): boolean {
  return event.type === "agent/message" && event.data.kind === "content";
}
