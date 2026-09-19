// system-prompt 全套（docs/SYSTEM-PROMPT.md §3，对照参考语义子集 A1–A10）：
// 锚点定位代数/注册期环检测/覆盖与身份守卫/插值降级/指纹/排序缓存/契约。

import { describe, expect, it } from "vitest";
import { createPromptRegistry } from "../registry.ts";
import type { SystemPromptService } from "../types.ts";

const names = (svc: SystemPromptService): string[] => {
  const text = svc.assemble().text;
  return text === "" ? [] : text.split("\n\n");
};

function reg(): SystemPromptService {
  return createPromptRegistry();
}

describe("锚点定位代数（docs/SYSTEM-PROMPT.md §1——A1/A2/A3/A7）", () => {
  it("after 置于目标之后；before 置于目标之前", () => {
    const svc = reg();
    svc.section({ name: "core", text: "CORE" });
    svc.section({ name: "extra", after: "core", text: "EXTRA" });
    svc.section({ name: "preamble", before: "core", text: "PRE" });
    expect(names(svc)).toEqual(["PRE", "CORE", "EXTRA"]);
  });

  it("缺席锚 no-op：目标未注册 → 约束不生效，段按无边段落尾", () => {
    const svc = reg();
    svc.section({ name: "a", text: "A" });
    svc.section({ name: "ghosted", after: "ghost", text: "G" });
    expect(names(svc)).toEqual(["A", "G"]);
  });

  it("链式锚递归：c after b after core → core,b,c", () => {
    const svc = reg();
    svc.section({ name: "core", text: "C" });
    svc.section({ name: "b", after: "core", text: "B" });
    svc.section({ name: "c", after: "b", text: "C2" });
    expect(names(svc)).toEqual(["C", "B", "C2"]);
  });

  it("同锚多后代 δ/2ⁿ：后注册者更贴近锚", () => {
    const svc = reg();
    svc.section({ name: "core", text: "C" });
    svc.section({ name: "first", after: "core", text: "F" });
    svc.section({ name: "second", after: "core", text: "S" });
    expect(names(svc)).toEqual(["C", "S", "F"]); // second（后注册）插在 core 与 first 之间
  });

  it("无边段插链间：注册序早于锚的无边段可插进锚链之前，晚于者落链后", () => {
    const svc = reg();
    svc.section({ name: "core", text: "C" });
    svc.section({ name: "other", text: "O" }); // 无边段，注册序在 core 之后
    svc.section({ name: "mid", after: "core", text: "M" }); // 派生位次 = core+δ，插在 core 与 other 之间
    expect(names(svc)).toEqual(["C", "M", "O"]);
  });

  it("回归：子段先于锚注册（前向引用）仍按注册序贴近——预热分配 n", () => {
    const svc = reg();
    svc.section({ name: "first", after: "core", text: "F" }); // core 缺席：先建段
    svc.section({ name: "second", after: "core", text: "S" });
    svc.section({ name: "core", text: "C" }); // 锚后到
    expect(names(svc)).toEqual(["C", "S", "F"]); // second（后注册）更贴近 core
  });

  it("平位 tie-break 回归（审查处置）：P before Q 且 Q after X → P 与 X 平位，注册序定先后", () => {
    const svc = reg();
    svc.section({ name: "X", text: "X" });
    svc.section({ name: "Q", after: "X", text: "Q" });
    svc.section({ name: "P", before: "Q", text: "P" }); // P 位次 = orderOf(Q)-δ = orderOf(X)，与 X 平位
    expect(names(svc)).toEqual(["X", "P", "Q"]); // 注册序 tie-break：X(0) 先于 P(2)
  });

  it("after+before 同声明 → throw；自锚 → throw", () => {
    const svc = reg();
    expect(() => svc.section({ name: "a", after: "x", before: "y", text: "" })).toThrow("both after and before");
    expect(() => svc.section({ name: "a", after: "a", text: "" })).toThrow("anchor to itself");
  });

  it("注册期成环 throw（点名环成员）；assemble 不因环中弹", () => {
    const svc = reg();
    svc.section({ name: "a", after: "b", text: "A" }); // b 缺席 → no-op 建段
    expect(() => svc.section({ name: "b", after: "a", text: "B" })).toThrow("section cycle: b -> a");
    expect(names(svc)).toEqual(["A"]); // 注册失败不留半态，assemble 正常
  });
});

describe("覆盖与注销（身份守卫——A4 适配）", () => {
  it("同名覆盖后者胜，沿用旧注册序；旧 disposer 不误删新段", () => {
    const svc = reg();
    const offOld = svc.section({ name: "a", text: "old" });
    const offNew = svc.section({ name: "a", text: "new" });
    expect(names(svc)).toEqual(["new"]);
    offOld(); // 旧 disposer no-op（身份守卫）
    expect(names(svc)).toEqual(["new"]);
    offNew();
    expect(names(svc)).toEqual([]);
  });

  it("覆盖顶替锚目标语义：他段的 after 指向新内容；覆盖成环（core↔x）拒绝且旧段保留", () => {
    const svc = reg();
    svc.section({ name: "core", text: "C1" });
    svc.section({ name: "x", after: "core", text: "X" });
    svc.section({ name: "core", text: "C2" }); // 文本覆盖：位置不变，x 仍跟在 core 后
    expect(names(svc)).toEqual(["C2", "X"]);
    expect(() => svc.section({ name: "core", after: "x", text: "C3" })).toThrow("section cycle"); // core→x→core 真环拒绝
    expect(names(svc)).toEqual(["C2", "X"]); // 拒绝不留半态
  });

  it("变量注销身份守卫", () => {
    const svc = reg();
    const offOld = svc.variable("v", "1");
    const offNew = svc.variable("v", "2");
    offOld();
    expect(svc.assemble().text).toBe(""); // 未注册变量在空文本无表现——经 section 验证：
    svc.section({ name: "s", text: "{{v}}" });
    expect(svc.assemble().text).toBe("2");
    offNew();
    expect(svc.assemble().text).toBe("{{v}}");
  });
});

describe("插值与指纹（A6/A8/A9 适配）", () => {
  it("字符串/惰性函数/未注册保持/单层不递归/函数抛错保持原样", () => {
    const svc = reg();
    svc.variable("who", "world");
    svc.variable("lazy", () => "now");
    svc.variable("boom", () => {
      throw new Error("nope");
    });
    svc.section({ name: "s", text: "hi {{who}} {{lazy}} {{missing}} {{boom}} {{{who}}}" });
    const text = svc.assemble().text;
    expect(text).toBe("hi world now {{missing}} {{boom}} {world}");
  });

  it("指纹：同内容稳定；内容变即变；变量现算变即变", () => {
    const svc = reg();
    let tick = 1;
    svc.variable("n", () => String(tick));
    svc.section({ name: "s", text: "n={{n}}" });
    const first = svc.assemble();
    expect(svc.assemble().fingerprint).toBe(first.fingerprint); // 同内容稳定
    tick = 2;
    expect(svc.assemble().fingerprint).not.toBe(first.fingerprint); // 函数现算 → 指纹变
    svc.section({ name: "s", text: "changed" });
    expect(svc.assemble().fingerprint).not.toBe(first.fingerprint);
  });
});

describe("排序缓存与契约（A10 适配）", () => {
  it("段集未变连续 assemble 相等（缓存复用）；注册/注销后失效", () => {
    const svc = reg();
    svc.section({ name: "a", text: "A" });
    svc.section({ name: "b", after: "a", text: "B" });
    const first = svc.assemble();
    expect(svc.assemble()).toEqual(first); // 相等结果（缓存或现算皆须一致）
    const off = svc.section({ name: "c", text: "C" });
    expect(names(svc)).toEqual(["A", "B", "C"]);
    off();
    expect(names(svc)).toEqual(["A", "B"]);
  });

  it("注册垃圾参数 throw 表", () => {
    const svc = reg();
    expect(() => svc.section({ name: "", text: "" })).toThrow();
    expect(() => svc.section({ name: "a", text: 1 as never })).toThrow();
    expect(() => svc.section({ name: "a", text: "", after: "" })).toThrow();
    expect(() => svc.section({ name: "a", text: "", before: "" })).toThrow();
    expect(() => svc.variable("", "x")).toThrow();
    expect(() => svc.variable("v", 1 as never)).toThrow();
  });

  it("text 函数形：每次 assemble 现算（惰性）；抛错降级占位不中断；与变量插值共存", () => {
    const svc = reg();
    let tick = 1;
    svc.section({ name: "lazy", text: () => `TICK=${tick}` });
    svc.section({ name: "boom", text: () => { throw new Error("nope"); } });
    svc.section({ name: "steady", text: "hi {{who}}" });
    svc.variable("who", "world");
    const first = svc.assemble().text;
    expect(first).toContain("TICK=1");
    expect(first).toContain("[section boom render error: nope]"); // 段级降级
    expect(first).toContain("hi world"); // 其余段照常
    tick = 2;
    expect(svc.assemble().text).toContain("TICK=2"); // 每次 assemble 现算
  });

  it("text 函数形：指纹随现算值变", () => {
    const svc = reg();
    let tick = 1;
    svc.section({ name: "s", text: () => String(tick) });
    const first = svc.assemble();
    tick = 2;
    expect(svc.assemble().fingerprint).not.toBe(first.fingerprint);
  });

  it("assemble 确定性：两次调用文本与指纹逐字节相等", () => {
    const svc = reg();
    svc.section({ name: "a", text: "{{x}}" });
    svc.variable("x", "1");
    const first = svc.assemble();
    const second = svc.assemble();
    expect(second.text).toBe(first.text);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
