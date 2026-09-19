// 文件操作账本（docs/COMPACTION.md §1.1）：压缩不丢模型的文件世界观——被摘要区间的
// read/write/edit 提取为清单，跨压缩累积（并入上一份摘要携带的既有清单），以
// <read-files>/<modified-files> 标签附加在摘要尾。工具名口径可配置（宿主改命令名后
// 对齐，换名不再静默空账本）。

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

/** 本仓命令名缺省（tool-read/tool-write；edit 命令暂缺——edited 空集待命令落地后对齐） */
export const DEFAULT_FILE_TOOLS: FileToolNames = {
  read: ["read"],
  written: ["write"],
  edited: [],
};

function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** tool_use 的 input 为原始 JSON 串：解析取 path 字符串（垃圾降级 undefined） */
function pathOfInput(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const path = (parsed as { path?: unknown }).path;
      if (typeof path === "string") return path;
    }
  } catch {
    /* 降级 undefined */
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

/** assistant 节点的 tool_use 块 → 文件操作记账（按配置的工具名口径） */
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

/** 疑似文件操作信号：存在带 path 入参的 tool_use（账本为空时的告警判据） */
export function hasPathBearingToolUse(nodes: readonly SurfaceNode[]): boolean {
  return nodes.some((node) => toolUseBlocks(node).some((call) => pathOfInput(call.input) !== undefined));
}

/** 汇总清单：modified = written ∪ edited；read 剔除已改文件（排序稳定） */
export function computeFileLists(ops: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter((file) => !modified.has(file)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** 清单 → 摘要尾标签（自解析格式的另一端——跨压缩累积的数据载体；与续航注入语的
 *  组装序：标签在前、注入语在后，解析取末次匹配不受污染） */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/** 上一份摘要 → 既有清单（自格式解析：跨压缩累积）。解析失败静默空清单（降级）。
 *  取**末次**匹配：权威清单永远在摘要尾，正文镜像抄写的同名标签不得覆盖权威清单。 */
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

/** 完整账本：区间节点的操作 + 既有清单合并 */
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
