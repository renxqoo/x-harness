// ChannelCollector onChunk 单元（BATCH2-DESIGN §2.2）：增量回调点先于保留帽早退
// （过帽仍流）、观察者 throw 防御性吞掉（pump 存活优先）、空串跳过。
import { describe, expect, it } from "vitest";
import { ChannelCollector } from "../collect.ts";

describe("ChannelCollector onChunk", () => {
  it("逐块回调先于保留帽早退——过帽仍流（对齐直执行面 truncated 口径）", () => {
    const seen: string[] = [];
    const c = new ChannelCollector({ fullCapBytes: 8, onChunk: (t) => seen.push(t) });
    c.push("hello");
    c.push("-world-xxx"); // 超 8B 帽 → fullCapped 置位
    c.push("more"); // 已过帽：累积早退，回调仍达
    expect(seen).toEqual(["hello", "-world-xxx", "more"]);
    expect(c.fullCapped).toBe(true);
  });

  it("观察者 throw 不杀后续推送（pump 存活优先——回归 BATCH2 审 M3）", () => {
    let threw = false;
    const c = new ChannelCollector({
      onChunk: () => {
        if (!threw) {
          threw = true;
          throw new Error("observer bug");
        }
      },
    });
    expect(() => c.push("a")).not.toThrow();
    c.push("b");
    expect(c.full).toBe("ab");
  });

  it("空串不回调不累积；无 onChunk 构造照常", () => {
    const seen: string[] = [];
    const withHook = new ChannelCollector({ onChunk: (t) => seen.push(t) });
    withHook.push("");
    expect(seen).toEqual([]);
    const plain = new ChannelCollector();
    plain.push("x");
    expect(plain.full).toBe("x");
  });
});
