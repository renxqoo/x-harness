// jsonl 分帧契约矩阵（MIGRATION §5 jsonl 块移植 + HUB 行限）：LF-only、\r、空行、
// U+2028 不切、粘包半行、字节真值上限、单行单报、flush 尾行。
import { describe, expect, test } from "vitest";
import { createJsonlSplitter } from "../shared/jsonl.ts";

const MB = 1024 * 1024;

describe("jsonl splitter", () => {
  test("LF 分帧与多行一次 feed", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    const r = s.feed(Buffer.from('{"a":1}\n{"a":2}\n'));
    expect(r.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(r.oversize).toBe(0);
  });

  test("行尾 \\r 容忍", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    expect(s.feed(Buffer.from('{"a":1}\r\n')).lines).toEqual(['{"a":1}']);
  });

  test("空行忽略", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    expect(s.feed(Buffer.from('\n\n\x20\x20\n{"a":1}\n\n')).lines).toEqual(['{"a":1}']);
  });

  test("U+2028/U+2029 不切行（JSON 字符串内合法）", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    const payload = JSON.stringify({ text: "a\u2028b\u2029c" });
    expect(s.feed(Buffer.from(`${payload}\n`)).lines).toEqual([payload]);
  });

  test("粘包半行：跨 feed 重组", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    expect(s.feed(Buffer.from('{"a":')).lines).toEqual([]);
    const r = s.feed(Buffer.from('1}\n'));
    expect(r.lines).toEqual(['{"a":1}']);
  });

  test("字节真值上限：多字节字符按 utf-8 字节计", () => {
    const s = createJsonlSplitter({ maxLineBytes: 8 });
    // 8 字节上限：{"a":"你"} = 1+3+1+1+3+1 = 10 字节超限
    const r = s.feed(Buffer.from('{"a":"你"}\n'));
    expect(r.lines).toEqual([]);
    expect(r.oversize).toBe(1);
  });

  test("超限整行丢弃恰报一次：残余字节静默吸收", () => {
    const s = createJsonlSplitter({ maxLineBytes: 8 });
    const first = s.feed(Buffer.from("0123456789ABCDEF"));
    expect(first.oversize).toBe(1);
    const mid = s.feed(Buffer.from("MORE-GARBAGE"));
    expect(mid.oversize).toBe(0);
    const done = s.feed(Buffer.from("\n{\"ok\":1}\n"));
    expect(done.oversize).toBe(0);
    expect(done.lines).toEqual(['{"ok":1}']);
  });

  test("flush 取无换行尾行", () => {
    const s = createJsonlSplitter({ maxLineBytes: 16 * MB });
    s.feed(Buffer.from('{"a":1}\n{"b":'));
    expect(s.flush().lines).toEqual(['{"b":']);
    // 二次 flush 空
    expect(s.flush().lines).toEqual([]);
  });

  test("flush 超限尾行丢弃", () => {
    const s = createJsonlSplitter({ maxLineBytes: 4 });
    s.feed(Buffer.from("TOOLONGTAIL"));
    expect(s.flush().lines).toEqual([]);
  });
});
