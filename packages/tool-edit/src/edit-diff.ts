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

function splitChunkLines(value: string): string[] {
  const raw = value.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return raw;
}

function contextLine(line: string, lineNum: number, width: number): string {
  return ` ${String(lineNum).padStart(width, " ")} ${line}`;
}

function elidedLine(width: number): string {
  return ` ${"".padStart(width, " ")} ...`;
}

interface LineCursor {
  oldLineNum: number;
  newLineNum: number;
}

function advance(cursor: LineCursor, n: number): void {
  cursor.oldLineNum += n;
  cursor.newLineNum += n;
}

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
