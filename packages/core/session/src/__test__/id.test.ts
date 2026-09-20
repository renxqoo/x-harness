// mintSessionId（docs/SESSION.md §1.5 铸号契约）：词表安全 + 时间戳形态 + 注入随机的确定性/唯一性。

import { describe, expect, it } from "vitest";
import { isSafeSessionId, mintSessionId } from "../index.ts";

const NOW = new Date("2026-09-19T08:07:06.500Z");

describe("mintSessionId", () => {
  it("形态 = UTC 时间戳-6 位随机，且过 isSafeSessionId 词表门", () => {
    const id = mintSessionId(NOW, () => 0);
    expect(id).toBe("20260919T080706-aaaaaa");
    expect(isSafeSessionId(id)).toBe(true);
  });

  it("注入随机确定可测；不同随机产出不同后缀", () => {
    expect(mintSessionId(NOW, () => 0)).not.toBe(mintSessionId(NOW, () => 0.99));
  });

  it("同秒批量生成无撞名（随机段负责熵）", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seen.add(mintSessionId(NOW));
    }
    expect(seen.size).toBe(500);
  });

  it("注入 random 返回 ≥1（越界）钳到词表末位——不产出越界拼接串", () => {
    const id = mintSessionId(NOW, () => 1);
    expect(id).toBe("20260919T080706-999999"); // 钳制到词表末位（[a-z0-9] 的 35 号 = '9'）：恒取词表内字符
    expect(isSafeSessionId(id)).toBe(true);
  });

  it("字典序 = 时间序（早时间戳 id 排前面）", () => {
    const early = mintSessionId(new Date("2026-01-01T00:00:00Z"), () => 0);
    const late = mintSessionId(new Date("2027-01-01T00:00:00Z"), () => 0);
    expect(early < late).toBe(true);
  });
});
