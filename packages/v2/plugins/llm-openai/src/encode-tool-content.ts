import type { LlmMessage } from "../../llm/src/contracts";

export function encodeToolContent(message: LlmMessage): LlmMessage["content"] {
  return message.role === "tool" && message.isError
    ? [{ type: "text", text: JSON.stringify({ isError: true }) }, ...message.content]
    : message.content;
}
