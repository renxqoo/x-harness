// 截断契约（MIGRATION §5 truncate 块移植）：多字节热路径、marker 守预算、退化条件
// `>`、丢头保尾、truncated 标志。
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
    // 两个 emoji（8 字节）+ marker（3 字节）= 11
    expect(r.text).toBe("😀😀…");
  });

  test("marker 守预算（`>` 退化条件——等值合法带 marker）", () => {
    // cap 5：cut 2 字节 + marker 3 字节
    expect(truncateBytes("abcdef", 5, "…")).toEqual({ text: "ab…", truncated: true });
    // marker 3 字节 == cap 3：等值合法（非退化）→ cut 0 + marker，总 3 字节守恒
    expect(truncateBytes("abcdef", 3, "...")).toEqual({ text: "...", truncated: true });
    // marker 4 字节 > cap 3：退化无 marker 切头（上限恒成立）
    expect(truncateBytes("abcdef", 3, "....")).toEqual({ text: "abc", truncated: true });
  });

  test("tailBytes 丢头保尾 + marker 前缀（字节预算）", () => {
    // cap 4：marker 3 + 尾 1 字节
    expect(tailBytes("abcdefgh", 4)).toEqual({ text: "…h", truncated: true });
    // 两 emoji 8 字节 == cap 8：不截断
    expect(tailBytes("😀😀", 8)).toEqual({ text: "😀😀", truncated: false });
    // cap 7：marker 3 + 尾 4 字节 = 一个 emoji
    expect(tailBytes("😀😀😀😀", 7)).toEqual({ text: "…😀", truncated: true });
  });

  test("cutToBytes/cutFromTail 边界", () => {
    expect(cutToBytes("héllo", 2)).toBe("h"); // é 2 字节装不下
    expect(cutFromTail("héllo", 2)).toBe("lo");
    expect(cutToBytes("", 5)).toBe("");
    expect(cutFromTail("", 5)).toBe("");
  });
});
