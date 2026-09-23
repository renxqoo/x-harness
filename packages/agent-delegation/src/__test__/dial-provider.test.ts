// 子代理拨号跨 provider 串线红测（症状：子代理模型与主 agent 不同即报错——model
// 换了 provider 没换）：①类型 .md 的 `model: provider/model` 复合串（主应用设置界面
// 写入形态）必须拆解；②裸模型名跨 provider 时 provider 不得静默继承父（目录反查联动）。
import { describe, expect, it } from "vitest";
import { inheritDial } from "../lineage.ts";
import type { AgentHandle } from "@x-harness/agent-loop";
import type { LoadedAgentType } from "../types.ts";

const parentOf = (model: string, provider: string): AgentHandle =>
  ({ agent: { options: { model, provider } } }) as never as AgentHandle;

const typeOf = (spec: { model?: string; provider?: string }): LoadedAgentType =>
  ({ name: "t", description: "", ...spec }) as LoadedAgentType;

describe("inheritDial 跨 provider 联动（§7.3 修订）", () => {
  it("复合串 `glm/glm-5.3` → 拆解为 provider=glm + model=glm-5.3（不再原样透传）", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), { type: typeOf({ model: "glm/glm-5.3" }) });
    expect(dial).toEqual({ provider: "glm", model: "glm-5.3" });
  });

  it("复合串跨 provider `deepseek/deepseek-flash` → provider 跟随复合串（不继承父 glm）", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), { type: typeOf({ model: "deepseek/deepseek-flash" }) });
    expect(dial).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("裸模型名 + 显式 provider 字段 → 原语义不变", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), { type: typeOf({ model: "deepseek-flash", provider: "deepseek" }) });
    expect(dial).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("裸模型名无 provider + 目录反查命中唯一归属 → provider 联动（不再静默串线）", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), {
      type: typeOf({ model: "deepseek-flash" }),
      resolveProviderOf: (model) => (model === "deepseek-flash" ? "deepseek" : undefined),
    });
    expect(dial).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("裸模型名目录查不到 → 回落父 provider（兼容既有部署）", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), {
      type: typeOf({ model: "unknown-model" }),
      resolveProviderOf: () => undefined,
    });
    expect(dial).toEqual({ provider: "glm", model: "unknown-model" });
  });

  it("override 复合串同样拆解（spawn.model 参数面）", () => {
    const dial = inheritDial(parentOf("glm-5.3", "glm"), { override: { model: "deepseek/deepseek-flash" } });
    expect(dial).toEqual({ provider: "deepseek", model: "deepseek-flash" });
  });
});
