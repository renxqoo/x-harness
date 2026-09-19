// 初始消息拼接（docs/CLI.md §2.1）：stdin+@file+首条消息依序直连；全空 → undefined。

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { buildInitialMessage } from "../build-initial-message.ts";
import { readPipedStdin } from "../read-stdin.ts";

describe("buildInitialMessage", () => {
  it("三者依序直连（无分隔符）", () => {
    expect(buildInitialMessage({ stdin: "S", fileText: "F", firstMessage: "M" })).toBe("SFM");
  });

  it("部分缺席跳过；全空 → undefined", () => {
    expect(buildInitialMessage({ fileText: "F" })).toBe("F");
    expect(buildInitialMessage({ stdin: "  " })).toBe("  ");
    expect(buildInitialMessage({})).toBeUndefined();
    expect(buildInitialMessage({ stdin: "", fileText: "", firstMessage: "" })).toBeUndefined();
  });
});

describe("readPipedStdin", () => {
  it("管道流全量读取", async () => {
    const stream = new PassThrough();
    stream.write("hello ");
    stream.end("world");
    expect(await readPipedStdin(stream)).toBe("hello world");
  });

  it("TTY 流直接空串（不挂起）", async () => {
    const tty = new PassThrough();
    (tty as { isTTY?: boolean }).isTTY = true;
    expect(await readPipedStdin(tty)).toBe("");
  });
});
