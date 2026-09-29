import { describe, expect, it } from "vitest";
import { adjudicate, adjudicateChain, extractPayload, stripCodeFence, validateSubset } from "../index.ts";
import type { Evidence } from "../index.ts";

const BUDGET = { repairs: 2, reopens: 1, verifyAttempts: 3 };

describe("adjudicate：三档裁决矩阵", () => {
  it("schema：无违规 + 有载荷 → accept", () => {
    expect(adjudicate({ tier: "schema", evidence: { kind: "schema", extracted: { a: 1 }, violations: [] }, budget: BUDGET, used: { repairs: 0, reopens: 0 } })).toEqual({ kind: "accept" });
  });

  it("schema：有违规 → reject（预算内）；预算耗尽 → fail", () => {
    const evidence: Evidence = { kind: "schema", extracted: {}, violations: ["$.a expected string"] };
    expect(adjudicate({ tier: "schema", evidence: evidence, budget: BUDGET, used: { repairs: 0, reopens: 0 } })).toEqual({ kind: "reject", violations: ["$.a expected string"] });
    const exhausted = adjudicate({ tier: "schema", evidence: evidence, budget: BUDGET, used: { repairs: 2, reopens: 0 } });
    expect(exhausted.kind).toBe("fail");
    expect(exhausted.kind === "fail" && exhausted.reason).toContain("budget exhausted");
  });

  it("schema：无可抽取载荷 → reject 带「无可抽取」违规（铸文层据此引导结构化交付）", () => {
    const verdict = adjudicate({ tier: "schema", evidence: { kind: "schema", violations: [] }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(verdict).toEqual({ kind: "reject", violations: ["no extractable structured payload in the final message"] });
  });

  it("command：exit 0 → accept；非 0 → reject；undefined（unknown）→ reject", () => {
    expect(adjudicate({ tier: "command", evidence: { kind: "command", exitCode: 0, output: "" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } })).toEqual({ kind: "accept" });
    const rejected = adjudicate({ tier: "command", evidence: { kind: "command", exitCode: 1, output: "boom" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(rejected.kind).toBe("reject");
    const unknown = adjudicate({ tier: "command", evidence: { kind: "command", exitCode: undefined, output: "" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(unknown.kind).toBe("reject");
  });

  it("critic：pass → accept；fail+提案 → reject（提案即 violations）；无 verdict → reject", () => {
    expect(adjudicate({ tier: "critic", evidence: { kind: "critic", verdict: "pass" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } })).toEqual({ kind: "accept" });
    const failed = adjudicate({ tier: "critic", evidence: { kind: "critic", verdict: "fail", reopenProposals: ["fix auth flow"] }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(failed).toEqual({ kind: "reject", violations: ["fix auth flow"] });
    const noVerdict = adjudicate({ tier: "critic", evidence: { kind: "critic" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(noVerdict.kind).toBe("reject");
  });

  it("档与证据错配 → fail（采集器接线错误的防线）", () => {
    const verdict = adjudicate({ tier: "schema", evidence: { kind: "command", exitCode: 0, output: "" }, budget: BUDGET, used: { repairs: 0, reopens: 0 } });
    expect(verdict.kind).toBe("fail");
  });
});

describe("adjudicateChain：组合裁决（B+C 链）", () => {
  it("全 accept 才 accept；任一档 fail 终局；首个 reject 胜出", () => {
    const ok = adjudicateChain({ tiers: ["schema", "command"], evidenceOfTier: (tier) => (tier === "schema" ? { kind: "schema", extracted: { ok: true }, violations: [] } : { kind: "command", exitCode: 0, output: "" }), budget: BUDGET });
    expect(ok).toEqual({ kind: "accept" });
    const failFast = adjudicateChain({ tiers: ["schema", "command"], evidenceOfTier: (tier) => (tier === "command" ? { kind: "command", exitCode: 2, output: "x" } : undefined), budget: BUDGET, used: { repairs: 3, reopens: 0 } });
    expect(failFast.kind).toBe("fail");
    const reject = adjudicateChain({ tiers: ["schema"], evidenceOfTier: () => ({ kind: "schema", extracted: {}, violations: ["$.x"] }), budget: BUDGET });
    expect(reject.kind).toBe("reject");
  });
});

describe("extractPayload：宽松归一（ZCode 教训三分支）", () => {
  it("原样 JSON 直接过；代码围栏剥一层；非 JSON 返回 undefined", () => {
    expect(extractPayload('{"a":1}')).toEqual({ a: 1 });
    expect(extractPayload('结果如下\n```json\n{"a": 1}\n```\n以上')).toEqual({ a: 1 });
    expect(extractPayload("没有任何结构")).toBeUndefined();
    expect(extractPayload("")).toBeUndefined();
  });

  it("合法字符串载荷不被围栏逻辑破坏（'\"42\"' 保持字符串）", () => {
    expect(extractPayload('"42"')).toBe("42");
  });

  it("stripCodeFence：无围栏返回 undefined；嵌套围栏取首个", () => {
    expect(stripCodeFence("plain")).toBeUndefined();
    expect(stripCodeFence("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
});

describe("validateSubset：子集校验（违规指向模型可修改的值）", () => {
  const SCHEMA = {
    type: "object",
    required: ["title", "sections"],
    properties: {
      title: { type: "string", minLength: 1 },
      sections: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
      level: { enum: ["a", "b", "c"] },
    },
  };

  it("合格载荷零违规", () => {
    expect(validateSubset(SCHEMA, { title: "t", sections: [{ name: "s1" }] })).toEqual([]);
  });

  it("缺 required / 类型错 / enum 外 / minLength / 数组元素深检——路径化违规", () => {
    const violations = validateSubset(SCHEMA, { title: "", sections: [{ name: "ok" }, { titled: "x" }], level: "z" });
    const paths = violations.map((v) => v.path);
    expect(paths).toContain("$.title");
    expect(paths).toContain("$.sections[1].name");
    expect(paths).toContain("$.level");
    expect(violations.every((v) => v.expected.length > 0)).toBe(true);
  });

  it("超集语法忽略不拒（additionalProperties 等未知关键字零违规）", () => {
    expect(validateSubset({ type: "string", additionalProperties: false, pattern: "^x$" }, "anything")).toEqual([]);
  });
});

describe("宽松归一与枚举边角（补覆盖）", () => {
  it("围栏剥层后 JSON 解析 + enum 违规路径 + minLength 边界", () => {
    const payload = extractPayload("结果：\n```\n{\"level\": \"x\", \"name\": \"\"}\n```");
    expect(payload).toEqual({ level: "x", name: "" });
    const schema = { type: "object", properties: { level: { enum: ["a", "b"] }, name: { type: "string", minLength: 1 } } };
    const violations = validateSubset(schema, payload);
    expect(violations.length).toBe(2);
  });

  it("空围栏内容 → undefined（stripCodeFence 空内层）", () => {
    expect(stripCodeFence("```\n\n```")).toBe("");
    expect(extractPayload("```\n\n```")).toBeUndefined();
  });
});
