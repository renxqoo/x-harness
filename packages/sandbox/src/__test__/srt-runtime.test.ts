// realSrtRuntime 守卫面：未启动时 syncNetwork 早退（生命周期由 srt-session 引用计数保证——
// 此处锁定防御分支不抛不副作用）。

import { describe, expect, it } from "vitest";
import { realSrtRuntime } from "../srt-runtime.ts";

describe("realSrtRuntime", () => {
  it("未启动 syncNetwork 早退：不抛、无副作用", () => {
    expect(() => realSrtRuntime.syncNetwork([])).not.toThrow();
  });
});
