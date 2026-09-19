import { describe, expect, it } from "vitest";
import {
  defineEvent,
  defineGuard,
  defineSerial,
  defineService,
  defineWaterfall,
} from "../tokens.ts";

describe("token 铸造（§2.1）", () => {
  it("五种 define 的 kind/mode/name/freeze 形状", () => {
    const service = defineService<number>("svc");
    expect(service.kind).toBe("service");
    expect(service.name).toBe("svc");

    const event = defineEvent<{ v: number }>("evt");
    expect(event.kind).toBe("event");
    expect(event.mode).toBe("emit");
    expect(event.freeze).toBe("deep");

    const waterfall = defineWaterfall<number, string>("wf");
    expect(waterfall.kind).toBe("waterfall");
    expect(waterfall.mode).toBe("waterfall");

    const serial = defineSerial<{ v: number }>("ser");
    expect(serial.kind).toBe("serial");
    expect(serial.mode).toBe("serial");

    const guard = defineGuard<{ v: number }>("grd");
    expect(guard.kind).toBe("guard");
    expect(guard.mode).toBe("guard");
  });

  it("freeze 三档：缺省 deep / shell / none", () => {
    expect(defineEvent("a").freeze).toBe("deep");
    expect(defineEvent("b", { freeze: "shell" }).freeze).toBe("shell");
    expect(defineEvent("c", { freeze: "none" }).freeze).toBe("none");
  });

  it("非法名字（空串/非字符串）throw", () => {
    expect(() => defineService("")).toThrow("non-empty string");
    expect(() => defineEvent("")).toThrow("non-empty string");
    expect(() => defineWaterfall("")).toThrow("non-empty string");
    expect(() => defineSerial(42 as unknown as string)).toThrow("non-empty string");
    expect(() => defineGuard(null as unknown as string)).toThrow("non-empty string");
  });

  it("同名 token 重复 define 合法且互不可见（跨插件隔离域）", () => {
    const a = defineEvent<{ v: number }>("same-name");
    const b = defineEvent<{ v: number }>("same-name");
    expect(a).not.toBe(b);
    expect(a.name).toBe(b.name);
  });
});
