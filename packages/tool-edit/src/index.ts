export { createEditTool } from "./edit.ts";
export type { EditToolInput } from "./edit.ts";
export { createEditPlugin, editGuidance } from "./plugin.ts";
export type { EditPluginInput } from "./plugin.ts";
export {
  splitBom,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  findText,
  applyReplacementsPreservingUnchangedLines,
  applyEditsToNormalizedContent,
} from "./edit-apply.ts";
export type { LineEnding, TextEdit, FindTextResult, EditApplyResult, CountSpace } from "./edit-apply.ts";
export { generateDiffString } from "./edit-diff.ts";
export type { DiffStringResult } from "./edit-diff.ts";
