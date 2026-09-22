// realSrtRuntime 守卫面 + 平台依赖自探表（darwin 自探 sandbox-exec——srt 的 darwin 检查是空操作）。

import { describe, expect, it } from "vitest";
import { platformDepErrors, realSrtRuntime } from "../srt-runtime.ts";

describe("platformDepErrors", () => {
  it("darwin：sandbox-exec 在场=空；缺席=fail-closed 错误", () => {
    expect(platformDepErrors("darwin", () => "/usr/bin/sandbox-exec")).toEqual([]);
    expect(platformDepErrors("darwin", () => null)).toEqual(["sandbox-exec not found in PATH"]);
  });

  it("linux：自探不拦（bwrap/rg/socat 归 srt 检查）", () => {
    expect(platformDepErrors("linux", () => null)).toEqual([]);
  });

  it("非 POSIX 目标平台：直接不可用", () => {
    expect(platformDepErrors("win32", () => "/bin")).toEqual(["unsupported platform: win32"]);
  });
});

describe("realSrtRuntime", () => {
  it("未启动 syncNetwork 早退：不抛、无副作用", () => {
    expect(() => realSrtRuntime.syncNetwork([])).not.toThrow();
  });

  it("宿主平台依赖自探：darwin 开发机 sandbox-exec 必在场（缺席=本文件红）", async () => {
    expect(await realSrtRuntime.checkDeps()).toEqual([]);
  });
});
