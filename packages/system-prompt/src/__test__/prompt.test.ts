import { describe, expect, it } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import { systemPrompt, systemPromptPlugin } from "../index.ts";
import type { SystemPromptService } from "../index.ts";
import type { Context } from "@x-harness/core";

async function assemble(): Promise<{ ctx: Context; prompt: SystemPromptService }> {
  const ctx = createContext();
  await loadPlugins(ctx, [systemPromptPlugin]);
  return { ctx, prompt: ctx.use(systemPrompt) };
}

describe("token 与装配（docs/SYSTEM-PROMPT.md §1）", () => {
  it("token 名锁定", () => {
    expect(systemPrompt).toMatchObject({ kind: "service", name: "system-prompt" });
  });
  it("空注册 → assemble 空 text 且确定性", async () => {
    const { prompt } = await assemble();
    expect(prompt.assemble()).toEqual({ text: "" });
    expect(prompt.assemble()).toEqual(prompt.assemble());
  });
});

describe("sections 合并", () => {
  it("order 升序、同 order 按 name、join 双换行", async () => {
    const { prompt } = await assemble();
    prompt.section({ name: "b", order: 2, text: "B" });
    prompt.section({ name: "a", order: 1, text: "A" });
    prompt.section({ name: "c", order: 1, text: "C" }); // 同 order 按 name：a 在 c 前
    expect(prompt.assemble().text).toBe("A\n\nC\n\nB");
  });
  it("同名覆盖后者胜；旧 disposer 不误删新注册（身份守卫）", async () => {
    const { prompt } = await assemble();
    const off1 = prompt.section({ name: "s", order: 0, text: "old" });
    const off2 = prompt.section({ name: "s", order: 0, text: "new" });
    off1();
    expect(prompt.assemble().text).toBe("new");
    off2();
    expect(prompt.assemble().text).toBe("");
  });
});

describe("variables 插值", () => {
  it("字符串与函数值；函数每次现算", async () => {
    const { prompt } = await assemble();
    prompt.section({ name: "s", order: 0, text: "cwd={{cwd}} n={{n}}" });
    let n = 1;
    prompt.variable("cwd", "/x");
    prompt.variable("n", () => String(n));
    expect(prompt.assemble().text).toBe("cwd=/x n=1");
    n = 2;
    expect(prompt.assemble().text).toBe("cwd=/x n=2");
  });
  it("未注册变量保持原样；单层不递归", async () => {
    const { prompt } = await assemble();
    prompt.section({ name: "s", order: 0, text: "{{unknown}} {{a}}" });
    prompt.variable("a", "{{unknown}}");
    expect(prompt.assemble().text).toBe("{{unknown}} {{unknown}}");
  });
  it("变量注销", async () => {
    const { prompt } = await assemble();
    prompt.section({ name: "s", order: 0, text: "{{v}}" });
    const off = prompt.variable("v", "x");
    expect(prompt.assemble().text).toBe("x");
    off();
    expect(prompt.assemble().text).toBe("{{v}}");
  });
});

describe("注册参数垃圾 throw 表", () => {
  it("section/variable 参数垃圾", async () => {
    const { prompt } = await assemble();
    expect(() => prompt.section({ name: "", order: 0, text: "x" })).toThrow();
    expect(() => prompt.section({ name: "s", order: Number.NaN, text: "x" })).toThrow();
    expect(() => prompt.section({ name: "s", order: 0, text: 5 as never })).toThrow();
    expect(() => prompt.variable("", "x")).toThrow();
    expect(() => prompt.variable("v", 5 as never)).toThrow();
  });
});
