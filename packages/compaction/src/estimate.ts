// token 估算的消息面（docs/COMPACTION.md §1.4）：token-meter 的 estimateText 是
// 字符串→token 的单一真相，本文件只做消息/节点形状的求和——切点、配额、尾估、
// 占用共用单份，不另铸估算器。

import type { ContentBlock, SurfaceMessage, SurfaceNode } from "@x-harness/session";
import { estimateText } from "@x-harness/token-meter";

/** 视觉块 token 估算：视觉 API 对图普遍下采样（典型 ≤2k token/图）——按 base64 字节数
 *  估会高两个数量级误触压缩，取保守上界常量（高估促折叠，安全侧） */
export const IMAGE_TOKENS = 2048;

/** 块求和：text 计正文；image 计 IMAGE_TOKENS；tool_use 计 name + input（input 为原始 JSON 串，按串估） */
export function estimateBlocks(blocks: readonly ContentBlock[]): number {
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === "text") tokens += estimateText(block.text);
    else if (block.type === "image") tokens += IMAGE_TOKENS;
    else tokens += estimateText(block.name) + estimateText(block.input);
  }
  return tokens;
}

/** 单消息估算（四角色全覆盖——CJK 不低估是水位口径的前提） */
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

/** 投影节点估算（与 estimateMessage 同口径；直接读事件 data，不经过消息派生）。
 *  agent/message 计 content 块（模型可见——投影 user 角色，占用同口径） */
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
