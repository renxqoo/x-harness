import { describe, expect, it } from "vitest";
import { parseRgLine } from "../run-rg.ts";

interface Row {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly isContext: boolean;
  readonly truncated: boolean;
}

describe("parseRgLine 纯函数", () => {
  it("分类：match/context/other/malformed；空行命中保留", () => {
    const matches: Row[] = [];
    expect(parseRgLine(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }), matches, 500)).toBe("other");
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 3, lines: { text: "hit\n" } } }), matches, 500)).toBe("match");
    expect(parseRgLine(JSON.stringify({ type: "context", data: { path: { text: "a.ts" }, line_number: 2, lines: { text: "near\n" } } }), matches, 500)).toBe("context");
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: 5, lines: { text: "\n" } } }), matches, 500)).toBe("match");
    expect(parseRgLine("garbage {", matches, 500)).toBe("malformed");
    expect(matches[0]).toEqual({ path: "a.ts", line: 3, text: "hit", isContext: false, truncated: false });
    expect(matches[2]).toEqual({ path: "a.ts", line: 5, text: "", isContext: false, truncated: false });
  });

  it("回归（症状：UTF-16 截断曾劈开代理对出 U+FFFD）：500 预览边界落在代理对中间时回退一位", () => {
    const head = `${"x".repeat(499)}\ud83d\ude00\ud83d\ude00`;
    const matches: Row[] = [];
    parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "s.ts" }, line_number: 1, lines: { text: head } } }), matches, 500);
    const row = matches[0];
    if (row === undefined) throw new Error("row missing");
    expect(row.truncated).toBe(true);
    expect(row.text.endsWith("\ud83d\ude00")).toBe(false);
    expect(row.text.length).toBe(499);
  });

  it("回归（症状：latin1/GBK 文件的 lines.bytes 事件曾被静默丢弃→谎报零命中）：base64 回退解码", () => {
    const b64 = Buffer.from("caf\xe9 NEEDLE\n").toString("base64");
    const matches: Row[] = [];
    expect(parseRgLine(JSON.stringify({ type: "match", data: { path: { text: "latin1.txt" }, line_number: 1, lines: { bytes: b64 } } }), matches, 500)).toBe("match");
    const row = matches[0];
    if (row === undefined) throw new Error("row missing");
    expect(row.text).toContain("NEEDLE");
  });
});
