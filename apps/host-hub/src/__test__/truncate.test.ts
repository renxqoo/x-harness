import { describe, expect, test } from "vitest";
import { cutFromTail, cutToBytes, tailBytes, truncateBytes } from "../shared/truncate.ts";

describe("truncate", () => {
  test("限内原样不截断", () => {
    expect(truncateBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(tailBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  test("多字节不劈代理对（emoji 4 字节）", () => {
    const r = truncateBytes("😀😀😀😀", 11);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(11);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text).toBe("😀😀…");
  });

  test("marker 守预算（`>` 退化条件——等值合法带 marker）", () => {
    expect(truncateBytes("abcdef", 5, "…")).toEqual({ text: "ab…", truncated: true });
    expect(truncateBytes("abcdef", 3, "...")).toEqual({ text: "...", truncated: true });
    expect(truncateBytes("abcdef", 3, "....")).toEqual({ text: "abc", truncated: true });
  });

  test("tailBytes 丢头保尾 + marker 前缀（字节预算）", () => {
    expect(tailBytes("abcdefgh", 4)).toEqual({ text: "…h", truncated: true });
    expect(tailBytes("😀😀", 8)).toEqual({ text: "😀😀", truncated: false });
    expect(tailBytes("😀😀😀😀", 7)).toEqual({ text: "…😀", truncated: true });
  });

  test("cutToBytes/cutFromTail 边界", () => {
    expect(cutToBytes("héllo", 2)).toBe("h");
    expect(cutFromTail("héllo", 2)).toBe("lo");
    expect(cutToBytes("", 5)).toBe("");
    expect(cutFromTail("", 5)).toBe("");
  });
});
