// harness-home 定位（docs/CLI.md §2.1）：X_HARNESS_HOME 覆盖 ~/.x-harness；派生路径同根。

import { describe, expect, it } from "vitest";
import { harnessHome, defaultSessionRoot, providersPath } from "../harness-home.ts";

describe("harnessHome", () => {
  it("缺省 = ~/.x-harness", () => {
    expect(harnessHome({})).toBe(`${process.env.HOME ?? ""}/.x-harness`.replace("//", "/"));
  });

  it("X_HARNESS_HOME 覆盖（trim 空白）", () => {
    expect(harnessHome({ X_HARNESS_HOME: "/tmp/xh" })).toBe("/tmp/xh");
    expect(harnessHome({ X_HARNESS_HOME: "  /tmp/xh  " })).toBe("/tmp/xh");
  });

  it("X_HARNESS_HOME 空串回退缺省", () => {
    expect(harnessHome({ X_HARNESS_HOME: "   " })).toBe(harnessHome({}));
  });
});

describe("派生路径", () => {
  it("providers.json 与 sessions 都挂 home 根下", () => {
    const env = { X_HARNESS_HOME: "/tmp/xh" };
    expect(providersPath(env)).toBe("/tmp/xh/providers.json");
    expect(defaultSessionRoot(env)).toBe("/tmp/xh/sessions");
  });
});
