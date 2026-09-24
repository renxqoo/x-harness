// tool-edit 公共面：edit 纯函数域 + diff 组装（工具本体 edit.ts/plugin.ts 属后续批次）。

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
