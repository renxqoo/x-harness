// 节点/消息面估算已下移 token-meter（CONTEXT-TOKEN-UNIFICATION §3.1b H-1——环解除：
// estimateContextTokens 需要 nodeTokens，若留本包则 token-meter 反向依赖 compaction
// 成环）。本文件保留 re-export 是消费方 import 路径兼容面；新代码一律 import
// @x-harness/token-meter。

export { estimateMessage, estimateBlocks, nodeTokens, IMAGE_TOKENS } from "@x-harness/token-meter";
