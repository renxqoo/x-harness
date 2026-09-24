// edit 回显 diff 组装（docs/EDIT-TOOL.md）：npm diff 的 diffLines 分块 + 上下文窗口 +
// 每行新旧双轨行号（超长行内字符级变化在行 diff 下模型靠行号定位）。

import { diffLines } from "diff";

export interface DiffStringResult {
  readonly diff: string;
  readonly firstChangedLine?: number;
}

interface DiffChunk {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function isChange(chunk: DiffChunk): boolean {
  return chunk.added === true || chunk.removed === true;
}

/** 分块文本按 \n 切行并弹掉尾空段（尾换行不产生多余空行）。 */
function splitChunkLines(value: string): string[] {
  const raw = value.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return raw;
}

/** 单行输出：前置空格 + 旧轨行号（上下文行双轨同步，展示取旧轨）。 */
function contextLine(line: string, lineNum: number, width: number): string {
  return ` ${String(lineNum).padStart(width, " ")} ${line}`;
}

/** 上下文窗口中间被省略的行，输出对齐宽度的省略号。 */
function elidedLine(width: number): string {
  return ` ${"".padStart(width, " ")} ...`;
}

interface LineCursor {
  oldLineNum: number;
  newLineNum: number;
}

/** 两侧计数器同步推进 n 行（上下文块不改两侧行数差）。 */
function advance(cursor: LineCursor, n: number): void {
  cursor.oldLineNum += n;
  cursor.newLineNum += n;
}

/**
 * 生成带双轨行号的展示 diff：变更行 `+N `/`-N `（新/旧轨各自计数），上下文行 ` N `
 * 取旧轨行号。上下文窗口默认 4 行，超窗中间以省略行折叠。firstChangedLine 为
 * 新文件首个变更行（无可视变更时 undefined）。
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): DiffStringResult {
  const parts = diffLines(oldContent, newContent) as DiffChunk[];
  const output: string[] = [];
  const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
  const width = String(maxLineNum).length;
  const cursor: LineCursor = { oldLineNum: 1, newLineNum: 1 };
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lines = splitChunkLines(part.value);
    if (isChange(part)) {
      if (firstChangedLine === undefined) {
        firstChangedLine = cursor.newLineNum;
      }
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(cursor.newLineNum).padStart(width, " ")} ${line}`);
          cursor.newLineNum++;
        } else {
          output.push(`-${String(cursor.oldLineNum).padStart(width, " ")} ${line}`);
          cursor.oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = i < parts.length - 1 && isChange(parts[i + 1]!);
    appendContextWindow({ output, cursor, hasLeadingChange, hasTrailingChange, contextLines, width }, lines);
    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}

interface RenderState {
  output: string[];
  cursor: LineCursor;
  hasLeadingChange: boolean;
  hasTrailingChange: boolean;
  contextLines: number;
  width: number;
}

/** 上下文块四态渲染：双侧夹变更全显或折叠中段；单侧只显窗内；无邻变更整块跳过。 */
function appendContextWindow(state: RenderState, lines: string[]): void {
  const { output, cursor, hasLeadingChange, hasTrailingChange, contextLines, width } = state;
  if (!hasLeadingChange && !hasTrailingChange) {
    advance(cursor, lines.length);
    return;
  }
  if (hasLeadingChange && hasTrailingChange) {
    if (lines.length <= contextLines * 2) {
      for (const line of lines) {
        output.push(contextLine(line, cursor.oldLineNum, width));
        advance(cursor, 1);
      }
      return;
    }
    const leading = lines.slice(0, contextLines);
    const trailing = lines.slice(lines.length - contextLines);
    const skipped = lines.length - leading.length - trailing.length;
    for (const line of leading) {
      output.push(contextLine(line, cursor.oldLineNum, width));
      advance(cursor, 1);
    }
    output.push(elidedLine(width));
    advance(cursor, skipped);
    for (const line of trailing) {
      output.push(contextLine(line, cursor.oldLineNum, width));
      advance(cursor, 1);
    }
    return;
  }
  if (hasLeadingChange) {
    const shown = lines.slice(0, contextLines);
    const skipped = lines.length - shown.length;
    for (const line of shown) {
      output.push(contextLine(line, cursor.oldLineNum, width));
      advance(cursor, 1);
    }
    if (skipped > 0) {
      output.push(elidedLine(width));
      advance(cursor, skipped);
    }
    return;
  }
  const skipped = Math.max(0, lines.length - contextLines);
  if (skipped > 0) {
    output.push(elidedLine(width));
    advance(cursor, skipped);
  }
  for (const line of lines.slice(skipped)) {
    output.push(contextLine(line, cursor.oldLineNum, width));
    advance(cursor, 1);
  }
}
