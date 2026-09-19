// 拨号折叠与请求头落账单元（docs/AGENT-LOOP-DRIVER §1.4）：逐字段折叠（options 恒胜）、
// headerChanged 规范化比较（含 tools）、lastRequestContext、toToolRefs 投影。

import { describe, expect, it } from "vitest";
import type { SessionEvent, ToolRef } from "@x-harness/session";
import { foldDial, headerChanged, lastRequestContext, toToolRefs } from "../request.ts";
import type { ToolSchema } from "@x-harness/tools";

function headerEvent(data: Record<string, unknown>): SessionEvent {
  return { type: "request/header", seq: 0, time: 1, data: data as never } as SessionEvent;
}

const TOOLS: readonly ToolRef[] = [{ name: "a" }, { name: "b", description: "B" }];

describe("foldDial（docs/AGENT-LOOP-DRIVER §1.4：options 显式值恒胜）", () => {
  it("无 header 且 options 无 model → missing；空串 model 同样 missing", () => {
    expect(foldDial({}, [])).toEqual({ missing: true });
    expect(foldDial({ model: "" }, [])).toEqual({ missing: true });
  });

  it("options 全量显式 → 恒胜 header 同名字段", () => {
    const folded = foldDial(
      { provider: "p2", model: "m2", temperature: 0.7, maxTokens: 99 },
      [headerEvent({ model: "m1", provider: "p1", temperature: 0.1, maxTokens: 5, tools: TOOLS })],
    );
    expect(folded).toEqual({ model: "m2", provider: "p2", temperature: 0.7, maxTokens: 99 });
  });

  it("options 部分显式 → 缺字段由末次 header 同名回填", () => {
    const folded = foldDial({ model: "m2" }, [headerEvent({ model: "m1", provider: "p1", temperature: 0.1, tools: TOOLS })]);
    expect(folded).toEqual({ model: "m2", provider: "p1", temperature: 0.1 });
  });

  it("options 仅 model 且无 header → 最小拨号", () => {
    expect(foldDial({ model: "m" }, [])).toEqual({ model: "m" });
  });

  it("末次 header 生效（多次 header 取最后一帧）", () => {
    const folded = foldDial(
      { model: "m" },
      [headerEvent({ model: "old", provider: "p0", tools: [] }), headerEvent({ model: "m", provider: "p9", tools: TOOLS })],
    );
    expect(folded).toEqual({ model: "m", provider: "p9" });
  });

  it("thinking 等级同规则折叠：options 恒胜 / header 回填 / 缺席不落键", () => {
    expect(foldDial({ model: "m", thinking: "high" }, [headerEvent({ model: "m", thinking: "low", tools: TOOLS })])).toEqual({
      model: "m",
      thinking: "high",
    });
    expect(foldDial({ model: "m" }, [headerEvent({ model: "m", thinking: "low", tools: TOOLS })])).toEqual({
      model: "m",
      thinking: "low",
    });
    expect(foldDial({ model: "m" }, [headerEvent({ model: "m", tools: TOOLS })])).toEqual({ model: "m" });
  });
});

describe("headerChanged（规范化比较含 tools）", () => {
  const dial = { model: "m", provider: "p", temperature: 0.5, maxTokens: 10 };

  it("无历史 header → 落账", () => {
    expect(headerChanged(dial, TOOLS, [])).toBe(true);
  });

  it("完全一致 → 不落；任一字段漂移 → 落", () => {
    const same = [headerEvent({ model: "m", provider: "p", temperature: 0.5, maxTokens: 10, tools: TOOLS })];
    expect(headerChanged(dial, TOOLS, same)).toBe(false);
    expect(headerChanged({ ...dial, temperature: 0.6 }, TOOLS, same)).toBe(true);
    expect(headerChanged(dial, [{ name: "a" }, { name: "b" }], same)).toBe(true); // description 差异也算 tools 漂移
  });

  it("thinking 漂移 → 落账", () => {
    const dialSame = { model: "m", thinking: "low" as const };
    const headerSame = headerEvent({ model: "m", thinking: "low", tools: TOOLS });
    expect(headerChanged(dialSame, TOOLS, [headerSame])).toBe(false);
    expect(headerChanged({ ...dialSame, thinking: "high" }, TOOLS, [headerSame])).toBe(true);
    expect(headerChanged({ model: "m" }, TOOLS, [headerSame])).toBe(true); // 有→无也是漂移
  });

  it("可选字段缺席与显式 undefined 等价（undefined 不落账）", () => {
    const bare = [headerEvent({ model: "m", tools: TOOLS })];
    expect(headerChanged({ model: "m" }, TOOLS, bare)).toBe(false);
  });
});

describe("lastRequestContext / toToolRefs", () => {
  it("无 context → undefined；取末帧", () => {
    expect(lastRequestContext([])).toBeUndefined();
    const events = [
      { type: "request/context", seq: 0, time: 1, data: { provider: "p1", model: "m1" } },
      { type: "request/context", seq: 1, time: 2, data: { provider: "p2", model: "m2" } },
    ] as unknown as SessionEvent[];
    expect(lastRequestContext(events)).toEqual({ provider: "p2", model: "m2" });
  });

  it("toToolRefs 剥 inputSchema：description 缺席不落键", () => {
    const schemas: readonly ToolSchema[] = [
      { name: "a", inputSchema: { type: "object" } as never },
      { name: "b", description: "B", inputSchema: { type: "object" } as never },
    ];
    expect(toToolRefs(schemas)).toEqual([{ name: "a" }, { name: "b", description: "B" }]);
  });
});
