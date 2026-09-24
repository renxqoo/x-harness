// 白名单合并 + 集合等价（docs/SANDBOX.md §3）。

import { describe, expect, it } from "vitest";
import { mergeAllowlists, sameDomainSet } from "../allowlist.ts";

describe("mergeAllowlists", () => {
  it("多成员并集去重", () => {
    expect(
      mergeAllowlists([["a.test", "b.test"], ["b.test", "c.test"], []]),
    ).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("任一成员 ['*'] → 全通（吸收其余）", () => {
    expect(mergeAllowlists([["a.test"], ["*"], ["x.test"]])).toEqual(["*"]);
  });

  it("全空 → 空（全断）", () => {
    expect(mergeAllowlists([[], []])).toEqual([]);
  });
});

describe("sameDomainSet", () => {
  it("序不敏感等价", () => {
    expect(sameDomainSet(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("差一元素即不等", () => {
    expect(sameDomainSet(["a"], ["a", "b"])).toBe(false);
    expect(sameDomainSet(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("内部重复无义（集合语义）", () => {
    expect(sameDomainSet(["a", "a"], ["a"])).toBe(true);
  });
});
