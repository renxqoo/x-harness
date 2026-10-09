import { describe, expect, it } from "vitest";
import { commandError, readCommandError } from "../command-error.ts";

describe("CommandError 归一（症状「设备/owner 面只拿到未知错误，host 的 {code,message} 被丢」）", () => {
  it("host 上行的 {code,message} 原样可读回", () => {
    expect(readCommandError({ code: "thread_not_live", message: "thread parked" })).toEqual({ code: "thread_not_live", message: "thread parked" });
  });

  it("无 message 时只带 code；message 非字符串丢弃而非塞占位", () => {
    expect(readCommandError({ code: "unknown_command" })).toEqual({ code: "unknown_command" });
    expect(readCommandError({ code: "unknown_command", message: 7 })).toEqual({ code: "unknown_command" });
  });

  it("垃圾输入降级为 null：字符串/数组/null/空 code/缺 code 都不成形状", () => {
    expect(readCommandError("thread_not_live")).toBeNull();
    expect(readCommandError(["thread_not_live"])).toBeNull();
    expect(readCommandError(null)).toBeNull();
    expect(readCommandError(undefined)).toBeNull();
    expect(readCommandError({ code: "" })).toBeNull();
    expect(readCommandError({ message: "no code" })).toBeNull();
  });

  it("commandError 带不带 message 都只出这两个键", () => {
    expect(commandError("scope-denied")).toEqual({ code: "scope-denied" });
    expect(commandError("host-unavailable", "host unavailable")).toEqual({ code: "host-unavailable", message: "host unavailable" });
  });

  it("归一器往返：写出的形状能被自己读回", () => {
    expect(readCommandError(commandError("model_unavailable", "no such model"))).toEqual({ code: "model_unavailable", message: "no such model" });
  });
});