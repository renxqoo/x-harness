// newSessionId（docs/CLI.md §2.5）：词表安全 + 时间戳形态 + 注入随机的确定性/唯一性。

import { describe, expect, it } from "vitest";
import { isSafeSessionId } from "@x-harness/session";
import { newSessionId } from "../new-session-id.ts";

const NOW = new Date("2026-09-19T08:07:06.500Z");

describe("newSessionId", () => {
  it("形态 = UTC 时间戳-6 位随机，且过 isSafeSessionId 词表门", () => {
    const id = newSessionId(NOW, () => 0);
    expect(id).toBe("20260919T080706-aaaaaa");
    expect(isSafeSessionId(id)).toBe(true);
  });

  it("注入随机确定可测；不同随机产出不同后缀", () => {
    expect(newSessionId(NOW, () => 0)).not.toBe(newSessionId(NOW, () => 0.99));
  });

  it("同秒批量生成无撞名（随机段负责熵）", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seen.add(newSessionId(NOW));
    }
    expect(seen.size).toBe(500);
  });

  it("字典序 = 时间序（早时间戳 id 排前面）", () => {
    const early = newSessionId(new Date("2026-01-01T00:00:00Z"), () => 0);
    const late = newSessionId(new Date("2027-01-01T00:00:00Z"), () => 0);
    expect(early < late).toBe(true);
  });
});
