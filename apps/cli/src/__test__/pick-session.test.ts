// 编号选择（docs/CLI.md §2.3）：pickIndex 词表（合法/垃圾/取消）、pickSession 映射、
// 列表格式（截断上限/时间戳/子代理标注）。

import { describe, expect, it } from "vitest";
import type { SessionHeader } from "@x-harness/session";
import { formatSessionList, pickIndex, pickSession } from "../pick-session.ts";

function questionWith(answers: readonly string[]) {
  let index = 0;
  return () => {
    const answer = answers[index];
    index += 1;
    return Promise.resolve(answer);
  };
}

describe("pickIndex", () => {
  it("合法序号 → 0 基；越界/垃圾/空行 → undefined", async () => {
    expect(await pickIndex(3, questionWith(["2"]))).toBe(1);
    expect(await pickIndex(3, questionWith(["0"]))).toBeUndefined();
    expect(await pickIndex(3, questionWith(["4"]))).toBeUndefined();
    expect(await pickIndex(3, questionWith(["x"]))).toBeUndefined();
    expect(await pickIndex(3, questionWith([""]))).toBeUndefined();
    expect(await pickIndex(3, questionWith([undefined as unknown as string]))).toBeUndefined();
  });
});

describe("pickSession", () => {
  const headers: readonly SessionHeader[] = [
    { id: "one", createdAt: 0 } as SessionHeader,
    { id: "two", createdAt: 0 } as SessionHeader,
  ];

  it("序号映射到对应会话 id；取消 → undefined", async () => {
    expect(await pickSession(headers, questionWith(["1"]))).toBe("one");
    expect(await pickSession(headers, questionWith(["2"]))).toBe("two");
    expect(await pickSession(headers, questionWith([""]))).toBeUndefined();
  });
});

describe("formatSessionList", () => {
  it("序号 + id + UTC 时间；超过 15 条截断", () => {
    const many: readonly SessionHeader[] = Array.from({ length: 20 }, (_, index) => ({ id: `s${String(index)}`, createdAt: Date.UTC(2026, 8, 19, 1, 2) })) as SessionHeader[];
    const lines = formatSessionList(many);
    expect(lines).toHaveLength(15);
    expect(lines[0]).toMatch(/^1\. s0  2026-09-19 01:02$/);
  });

  it("子代理会话带类型标注（防御展示；主列表已过滤，此形态仅展示层）", () => {
    const lines = formatSessionList([{ id: "sub", createdAt: 0, agentId: "a1", agentType: "worker" } as SessionHeader]);
    expect(lines[0]).toContain("[worker]");
  });
});
