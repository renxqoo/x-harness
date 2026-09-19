// 文件账本（docs/COMPACTION.md §1.1；对照参照系 pure-file-ops 语义子集：承接往返/
// 末者胜/累积/工具名对齐，默认名改写为本仓命令 read/write，edited 空集待命令落地）。

import { describe, expect, it } from "vitest";
import {
  accumulateFileOps,
  computeFileLists,
  DEFAULT_FILE_TOOLS,
  formatFileOperations,
  hasPathBearingToolUse,
  parseFileOperations,
} from "../file-ops.ts";
import type { SurfaceNode } from "@x-harness/session";

function assistantToolNode(seq: number, calls: Array<{ name: string; input: unknown }>): SurfaceNode {
  return {
    seq,
    event: {
      type: "assistant/message",
      seq,
      time: 1,
      data: {
        turn: 0,
        step: 0,
        content: calls.map((call, i) => ({ type: "tool_use" as const, callId: `c${String(i)}`, name: call.name, input: JSON.stringify(call.input) })),
        stopReason: "stop",
      },
      surfaceOp: "append",
    },
  } as never;
}

describe("文件账本", () => {
  it("自格式往返：清单 → 标签 → 解析还原", () => {
    const formatted = formatFileOperations(["/a.ts", "/b.ts"], ["/c.ts"]);
    const parsed = parseFileOperations(`SUMMARY BODY${formatted}\n\nThe message above is...`);
    expect(parsed).toEqual({ readFiles: ["/a.ts", "/b.ts"], modifiedFiles: ["/c.ts"] });
  });

  it("空清单 → 空串（无标签）", () => {
    expect(formatFileOperations([], [])).toBe("");
    expect(parseFileOperations("no tags")).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("末次匹配胜（M3 症状回归：正文镜像不得覆盖权威清单）", () => {
    const text = [
      "<read-files>",
      "/mirrored-fake.ts",
      "</read-files>",
      "body...",
      "<read-files>",
      "/real-a.ts",
      "</read-files>",
    ].join("\n");
    expect(parseFileOperations(text).readFiles).toEqual(["/real-a.ts"]);
  });

  it("记账与汇总：modified = written ∪ edited；read 剔除已改文件", () => {
    const ops = accumulateFileOps(
      [
        assistantToolNode(0, [
          { name: "read", input: { path: "/keep.ts" } },
          { name: "read", input: { path: "/modified.ts" } },
          { name: "write", input: { path: "/modified.ts" } },
          { name: "bash", input: { command: "ls" } }, // 无 path——不记
          { name: "read", input: "not-json" }, // 垃圾降级
        ]),
      ],
      { readFiles: [], modifiedFiles: [] },
      DEFAULT_FILE_TOOLS,
    );
    expect(computeFileLists(ops)).toEqual({ readFiles: ["/keep.ts"], modifiedFiles: ["/modified.ts"] });
    expect(hasPathBearingToolUse([assistantToolNode(1, [{ name: "read", input: { path: "/x" } }])])).toBe(true);
    expect(hasPathBearingToolUse([assistantToolNode(2, [{ name: "bash", input: { command: "ls" } }])])).toBe(false);
  });

  it("工具名解耦（E4）：改名工具按配置记账；默认名不再命中", () => {
    const names = { read: ["cat_file"], written: ["write"], edited: [] };
    const ops = accumulateFileOps([assistantToolNode(0, [{ name: "cat_file", input: { path: "/z.ts" } }, { name: "read", input: { path: "/ignored.ts" } }])], { readFiles: [], modifiedFiles: [] }, names);
    expect(computeFileLists(ops)).toEqual({ readFiles: ["/z.ts"], modifiedFiles: [] });
  });

  it("跨压缩累积：上份清单并入（read 直传、modified 入 edited）", () => {
    const ops = accumulateFileOps([assistantToolNode(0, [{ name: "write", input: { path: "/new.ts" } }])], { readFiles: ["/old-read.ts"], modifiedFiles: ["/old-mod.ts"] }, DEFAULT_FILE_TOOLS);
    expect(computeFileLists(ops)).toEqual({ readFiles: ["/old-read.ts"], modifiedFiles: ["/new.ts", "/old-mod.ts"] });
  });
});
