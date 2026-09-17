import { describe, expect, it } from "vitest";
import { pluginEvent } from "../vocab.ts";

describe("内核自举词表封闭性（§6.1：导出常量 == 文档词表，双向）", () => {
  it("自举域 4 + 通用信封 1：名字与文档逐项相等", async () => {
    const vocab = await import("../vocab.ts");
    expect(vocab.serviceProvided.name).toBe("service/provided");
    expect(vocab.pluginLoaded.name).toBe("plugin/loaded");
    expect(vocab.pluginError.name).toBe("plugin/error");
    expect(vocab.contextDisposing.name).toBe("context/disposing");
    expect(vocab.pluginEvent.name).toBe("plugin/event");
  });

  it("无多余导出（词表只增不增：新词条必须先改文档）", async () => {
    const vocab = await import("../vocab.ts");
    expect(Object.keys(vocab).toSorted()).toEqual([
      "contextDisposing",
      "pluginError",
      "pluginEvent",
      "pluginLoaded",
      "serviceProvided",
    ]);
  });

  it("plugin/event 壳冻结：一级字段冻结、data 保持原引用（信任边界）", async () => {
    const { createContext } = await import("../create-context.ts");
    const ctx = createContext();
    let seen: { plugin: string; kind: string; data: unknown; ts: number } | undefined;
    ctx.on(pluginEvent, (payload) => {
      seen = payload;
    });
    const data = { mutable: true };
    ctx.emit(pluginEvent, { plugin: "x", kind: "k", data, ts: 1 });
    expect(Object.isFrozen(seen)).toBe(true); // 壳冻结
    expect(seen?.data).toBe(data); // data 原引用
    expect(Object.isFrozen(data)).toBe(false); // 信任边界：不承诺不可变
  });
});
