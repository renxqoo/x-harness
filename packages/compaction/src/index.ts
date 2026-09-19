// compaction 件 barrel（coverage 豁免惯例）。

export { createCompactionPlugin } from "./plugin.ts";
export type { CompactionOptions } from "./plugin.ts";
export { compactionRunner, compactionLanded, compactionServedWindow } from "./tokens.ts";
export type { CompactionRunner } from "./tokens.ts";
export type { CompactTrigger, CompactionResult, CompactionSkipReason, ResolvedConfig } from "./compact.ts";
export { runCompact, previousSummaryOf } from "./compact.ts";
export type { SummarizerFace, SummarizeOutcome, SummarizeInput } from "./summarize.ts";
export { summarize, runTextRequest, summaryInputMaxChars, buildSummarizePrompt, SUMMARIZATION_SYSTEM_PROMPT } from "./summarize.ts";
export { findCutPoint, isTurnStartNode, USER_QUOTE_TOKENS } from "./cut.ts";
export type { CutPolicy } from "./cut.ts";
export type { CutPoint } from "./cut.ts";
export { estimateMessage, estimateBlocks, nodeTokens } from "./estimate.ts";
export {
  neutralizeForSummary,
  neutralizeLineStarts,
  capSerializedConversation,
  serializeConversation,
  ROLE_LINE_PREFIXES,
  NEUTRALIZE_OPEN_TAGS,
} from "./serialize.ts";
export {
  DEFAULT_FILE_TOOLS,
  extractFileOpsFromNodes,
  hasPathBearingToolUse,
  computeFileLists,
  formatFileOperations,
  parseFileOperations,
  accumulateFileOps,
} from "./file-ops.ts";
export type { FileOperations, FileToolNames } from "./file-ops.ts";
export {
  compactionBaselineSeq,
  measureContext,
  shouldCompact,
  lastWindow,
  lastRoute,
  pendingClaimTokens,
} from "./occupancy.ts";
export type { Occupancy } from "./occupancy.ts";
export { SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT, AUTO_CONTINUATION_NOTE } from "./prompts.ts";
