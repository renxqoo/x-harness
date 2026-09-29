import type { SurfaceNode } from "@x-harness/session";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface FileToolNames {
  read: string[];
  written: string[];
  edited: string[];
}

export const DEFAULT_FILE_TOOLS: FileToolNames = {
  read: ["read"],
  written: ["write"],
  edited: [],
};

function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

function pathOfInput(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const path = (parsed as { path?: unknown }).path;
      if (typeof path === "string") return path;
    }
  } catch {
  }
  return undefined;
}

function toolUseBlocks(node: SurfaceNode): Array<{ readonly name: string; readonly input: string }> {
  if (node.event.type !== "assistant/message") return [];
  const out: Array<{ readonly name: string; readonly input: string }> = [];
  for (const block of node.event.data.content) {
    if (block.type !== "tool_use") continue;
    out.push({ name: block.name, input: block.input });
  }
  return out;
}

export function extractFileOpsFromNodes(nodes: readonly SurfaceNode[], ops: FileOperations, names: FileToolNames): void {
  for (const node of nodes) {
    for (const call of toolUseBlocks(node)) {
      const path = pathOfInput(call.input);
      if (path === undefined) continue;
      if (names.read.includes(call.name)) ops.read.add(path);
      else if (names.written.includes(call.name)) ops.written.add(path);
      else if (names.edited.includes(call.name)) ops.edited.add(path);
    }
  }
}

export function hasPathBearingToolUse(nodes: readonly SurfaceNode[]): boolean {
  return nodes.some((node) => toolUseBlocks(node).some((call) => pathOfInput(call.input) !== undefined));
}

export function computeFileLists(ops: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter((file) => !modified.has(file)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

export function parseFileOperations(summary: string): { readFiles: string[]; modifiedFiles: string[] } {
  const parse = (tag: string): string[] => {
    let lines: string[] = [];
    for (const match of summary.matchAll(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "g"))) {
      lines = (match[1] ?? "").split("\n").filter((line) => line.trim() !== "");
    }
    return lines;
  };
  return { readFiles: parse("read-files"), modifiedFiles: parse("modified-files") };
}

export function accumulateFileOps(
  nodes: readonly SurfaceNode[],
  previous: { readFiles: string[]; modifiedFiles: string[] },
  names: FileToolNames,
): FileOperations {
  const ops = createFileOps();
  for (const file of previous.readFiles) ops.read.add(file);
  for (const file of previous.modifiedFiles) ops.edited.add(file);
  extractFileOpsFromNodes(nodes, ops, names);
  return ops;
}
