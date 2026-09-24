import { describe, expect, it } from "vitest";
import { splitDialRef } from "../lineage.ts";

describe("splitDialRef：`provider/model` 复合串拆解（首个 '/' 切分）", () => {
  it("标准复合串拆出双段", () => {
    expect(splitDialRef("glm/glm-5.3")).toEqual({ provider: "glm", model: "glm-5.3" });
    expect(splitDialRef("deepseek/deepseek-flash")).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("裸模型名（无 '/'）返回 undefined——不误拆", () => {
    expect(splitDialRef("deepseek-flash")).toBeUndefined();
    expect(splitDialRef("glm-5.3")).toBeUndefined();
  });

  it("退化形态拒拆（空段 = 垃圾输入按裸名透传）", () => {
    expect(splitDialRef("/glm-5.3")).toBeUndefined();
    expect(splitDialRef("glm/")).toBeUndefined();
    expect(splitDialRef("")).toBeUndefined();
  });

  it("多段斜杠取首段为 provider（model 保留余下全段）", () => {
    expect(splitDialRef("openrouter/deepseek/deepseek-chat")).toEqual({ provider: "openrouter", model: "deepseek/deepseek-chat" });
  });
});
