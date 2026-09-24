// env 密钥清洗表驱动：键名命中/误伤邻词/大小写/值不扫描。

import { describe, expect, it } from "vitest";
import { scrubEnv } from "../scrub-env.ts";

describe("scrubEnv", () => {
  it("命中 KEY|PASSWORD|SECRET|TOKEN 任一片段即剥整条（大小写不敏感）", () => {
    const out = scrubEnv({
      PATH: "/bin",
      API_KEY: "x",
      password: "x",
      mySecret: "x",
      GH_TOKEN: "x",
      apiKey: "x",
    });
    expect(out).toEqual({ PATH: "/bin" });
  });

  it("不误伤非密钥键：HISTORY/TOKE/PASS/SENT 等（值含密钥词不剥——只匹配键名）", () => {
    const env = { HISTORY: "1", TOKE: "1", PASS: "1", SENT: "1", SAFE_VAR: "TOKEN=inside" };
    expect(scrubEnv(env)).toEqual(env);
  });

  it("子串语义延续：MONKEY/KEYBOARD 类含 KEY 片段的键也剥（保守方向）", () => {
    expect(scrubEnv({ MONKEY: "1", KEYBOARD: "1" })).toEqual({});
  });

  it("空输入 → 空输出", () => {
    expect(scrubEnv({})).toEqual({});
  });
});
