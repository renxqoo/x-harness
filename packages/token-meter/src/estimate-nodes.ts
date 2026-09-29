import type { ContentBlock, SurfaceMessage, SurfaceNode } from "@x-harness/session";
import { estimateText } from "./plugin.ts";

export const IMAGE_TOKENS = 2048;

export function estimateBlocks(blocks: readonly ContentBlock[]): number {
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === "text") tokens += estimateText(block.text);
    else if (block.type === "image") tokens += IMAGE_TOKENS;
    else tokens += estimateText(block.name) + estimateText(block.input);
  }
  return tokens;
}

export function estimateMessage(message: SurfaceMessage): number {
  switch (message.role) {
    case "system":
      return estimateText(message.text);
    case "user":
    case "assistant":
      return estimateBlocks(message.content);
    case "tool":
      return estimateText(message.content);
  }
}

export function nodeTokens(node: SurfaceNode): number {
  const event = node.event;
  switch (event.type) {
    case "system/message":
      return estimateText(event.data.text);
    case "user/message":
    case "assistant/message":
      return estimateBlocks(event.data.content);
    case "tool/result":
      return estimateText(event.data.content);
    case "agent/message":
      return estimateBlocks(event.data.content);
  }
}
